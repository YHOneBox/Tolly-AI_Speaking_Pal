use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};

use crate::error::{ensure_success, ApiError};
use crate::prefs::validate_voice;
use crate::sse::collect_frames;

const VOICES_URL: &str = "https://api.cartesia.ai/voices";
const TTS_URL: &str = "https://api.cartesia.ai/tts/sse";
const CARTESIA_VERSION: &str = "2026-08-14";
pub const TTS_MODEL: &str = "sonic-3.5";
pub const SAMPLE_RATE: u32 = 24_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOption {
    pub id: String,
    pub name: String,
    pub language: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsChunkEvent {
    turn_id: String,
    seq: u32,
    sample_rate: u32,
    encoding: &'static str,
    data_base64: String,
}

pub async fn list_voices(http: &reqwest::Client, api_key: &str) -> Result<Vec<VoiceOption>, ApiError> {
    let mut voices = fetch_voice_page(http, api_key, true).await?;
    if voices.is_empty() {
        voices = fetch_voice_page(http, api_key, false).await?;
    }
    voices.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    voices.dedup_by(|left, right| left.id == right.id);
    Ok(voices)
}

async fn fetch_voice_page(
    http: &reqwest::Client,
    api_key: &str,
    english_only: bool,
) -> Result<Vec<VoiceOption>, ApiError> {
    let mut voices = Vec::new();
    let mut starting_after: Option<String> = None;

    for _ in 0..2 {
        let mut request = http
            .get(VOICES_URL)
            .bearer_auth(api_key)
            .header("Cartesia-Version", CARTESIA_VERSION)
            .query(&[("limit", "100")]);
        if english_only {
            request = request.query(&[("language", "en")]);
        }
        if let Some(cursor) = &starting_after {
            request = request.query(&[("starting_after", cursor.as_str())]);
        }

        let response = request
            .send()
            .await
            .map_err(|err| ApiError::upstream(0, err.to_string()))?;
        let response = ensure_success(response).await?;
        let payload: Value = response
            .json()
            .await
            .map_err(|err| ApiError::upstream(0, err.to_string()))?;

        let page = payload
            .get("data")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        for voice in page {
            if let Some(option) = voice_option(&voice) {
                voices.push(option);
            }
        }

        let has_more = payload
            .get("has_more")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        starting_after = payload
            .get("next_page")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .filter(|value| !value.is_empty());
        if !has_more || starting_after.is_none() {
            break;
        }
    }

    Ok(voices)
}

fn voice_option(value: &Value) -> Option<VoiceOption> {
    let id = value.get("id")?.as_str()?.to_string();
    if validate_voice(&id).is_err() {
        return None;
    }
    let name = value
        .get("name")
        .and_then(|item| item.as_str())
        .unwrap_or("Voice")
        .to_string();
    let language = value
        .get("language")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    let description = value
        .get("description")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    Some(VoiceOption {
        id,
        name,
        language,
        description,
    })
}

pub async fn stream_speech<R: Runtime>(
    app: &AppHandle<R>,
    http: &reqwest::Client,
    api_key: &str,
    transcript: &str,
    voice_id: &str,
    voice_speed: f64,
    voice_volume: f64,
    turn_id: &str,
    generation: &Arc<AtomicU64>,
    generation_at_start: u64,
) -> Result<(), ApiError> {
    let transcript = transcript.trim();
    if transcript.is_empty() {
        return Err(ApiError::bad("There was nothing to speak."));
    }
    validate_voice(voice_id)?;

    let response = http
        .post(TTS_URL)
        .bearer_auth(api_key)
        .header("Cartesia-Version", CARTESIA_VERSION)
        .json(&json!({
            "model_id": TTS_MODEL,
            "transcript": transcript.chars().take(500).collect::<String>(),
            "voice": voice_id,
            "language": "en",
            "generation_config": {
                "speed": voice_speed,
                "volume": voice_volume,
            },
            "output_format": {
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": SAMPLE_RATE,
            }
        }))
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let response = ensure_success(response).await?;

    let mut seq = 0u32;
    collect_frames(response, |data| {
        if generation.load(Ordering::SeqCst) != generation_at_start {
            return Ok(true);
        }
        let event: Value = serde_json::from_str(data).unwrap_or(Value::Null);
        match event.get("type").and_then(|value| value.as_str()) {
            Some("chunk") => {
                let audio = event.get("data").and_then(|value| value.as_str()).unwrap_or("");
                if audio.is_empty() {
                    return Ok(false);
                }
                if STANDARD.decode(audio).is_err() {
                    return Err(ApiError::upstream(0, "Cartesia returned audio that could not be read."));
                }
                app.emit(
                    "tts-chunk",
                    TtsChunkEvent {
                        turn_id: turn_id.to_string(),
                        seq,
                        sample_rate: SAMPLE_RATE,
                        encoding: "pcm_s16le",
                        data_base64: audio.to_string(),
                    },
                )
                .map_err(|err| ApiError::storage(err.to_string()))?;
                seq = seq.saturating_add(1);
                Ok(false)
            }
            Some("done") => Ok(true),
            Some("error") => {
                let message = event
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Cartesia could not synthesize speech.");
                let status = event
                    .get("status_code")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0) as u16;
                if status == 429 {
                    return Err(ApiError::RateLimited {
                        message: message.to_string(),
                        retry_after_secs: None,
                    });
                }
                Err(ApiError::upstream(status, message))
            }
            _ => Ok(false),
        }
    })
    .await?;

    Ok(())
}
