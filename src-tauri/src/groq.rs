use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dual::{canonical_json, parse_dual_output};
use crate::error::{ensure_success, ApiError};
use crate::prompt::SYSTEM_PROMPT;
use crate::sse::collect_frames;

const GROQ_CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_STT_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";
const MAX_AUDIO_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListedModel {
    pub id: String,
    pub owned_by: String,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroqCatalog {
    pub chat: Vec<ListedModel>,
    pub speech: Vec<ListedModel>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug)]
pub struct LlmResult {
    pub raw_json: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

pub async fn list_models(http: &reqwest::Client, api_key: &str) -> Result<GroqCatalog, ApiError> {
    let response = http
        .get(GROQ_MODELS_URL)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let response = ensure_success(response).await?;
    let payload: Value = response
        .json()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    Ok(catalog_from_list(payload.get("data").and_then(|value| value.as_array())))
}

pub async fn transcribe(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    audio: Vec<u8>,
) -> Result<String, ApiError> {
    if audio.is_empty() {
        return Err(ApiError::bad("The recording was empty."));
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(ApiError::bad("That recording is too long. Keep an utterance under about 15 seconds."));
    }

    let part = reqwest::multipart::Part::bytes(audio)
        .file_name("utterance.wav")
        .mime_str("audio/wav")
        .map_err(|err| ApiError::bad(err.to_string()))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model)
        .text("language", "en")
        .text("response_format", "json")
        .text("temperature", "0")
        .text("prompt", "Two people talking casually.");

    let response = http
        .post(GROQ_STT_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let response = ensure_success(response).await?;
    let payload: Value = response
        .json()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let text = payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if text.is_empty() || text.eq_ignore_ascii_case("[BLANK_AUDIO]") || text.eq_ignore_ascii_case("[silence]") {
        return Ok(String::new());
    }
    Ok(text)
}

pub async fn converse(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    history: &[HistoryMessage],
) -> Result<LlmResult, ApiError> {
    let messages = build_messages(history)?;
    let response = http
        .post(GROQ_CHAT_URL)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "temperature": 0.8,
            "max_tokens": 420,
            "stream": true,
            "stream_options": { "include_usage": true },
            "response_format": { "type": "json_object" },
            "messages": messages,
        }))
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let response = ensure_success(response).await?;

    let mut content = String::new();
    let mut prompt_tokens = 0u64;
    let mut completion_tokens = 0u64;

    collect_frames(response, |data| {
        if data == "[DONE]" {
            return Ok(true);
        }
        let chunk: Value = serde_json::from_str(data).unwrap_or(Value::Null);
        if let Some(delta) = chunk
            .pointer("/choices/0/delta/content")
            .and_then(|value| value.as_str())
        {
            content.push_str(delta);
        }
        if let Some(usage) = chunk.get("usage") {
            if let Some(value) = usage.get("prompt_tokens").and_then(|item| item.as_u64()) {
                prompt_tokens = value;
            }
            if let Some(value) = usage.get("completion_tokens").and_then(|item| item.as_u64()) {
                completion_tokens = value;
            }
        }
        Ok(false)
    })
    .await?;

    if content.trim().is_empty() {
        return Err(ApiError::InvalidModelOutput {
            message: "The model returned an empty response.".into(),
        });
    }

    let output = parse_dual_output(&content).map_err(|message| ApiError::InvalidModelOutput { message })?;
    let raw_json = canonical_json(&output).map_err(|message| ApiError::InvalidModelOutput { message })?;

    if prompt_tokens == 0 && completion_tokens == 0 {
        prompt_tokens = estimate_tokens(&messages);
        completion_tokens = (raw_json.len() as u64 / 4).max(1);
    }

    Ok(LlmResult {
        raw_json,
        prompt_tokens,
        completion_tokens,
    })
}

fn build_messages(history: &[HistoryMessage]) -> Result<Vec<Value>, ApiError> {
    if history.is_empty() {
        return Err(ApiError::bad("Say or type something first."));
    }

    let mut messages = vec![json!({
        "role": "system",
        "content": SYSTEM_PROMPT,
    })];
    let start = history.len().saturating_sub(20);
    for message in &history[start..] {
        let role = match message.role.as_str() {
            "user" => "user",
            "assistant" => "assistant",
            other => {
                return Err(ApiError::bad(format!("Unknown message role: {other}")));
            }
        };
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        messages.push(json!({
            "role": role,
            "content": truncate_chars(content, 2_000),
        }));
    }

    if messages.len() == 1 {
        return Err(ApiError::bad("Say or type something first."));
    }
    Ok(messages)
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    input.chars().take(max_chars).collect()
}

fn catalog_from_list(models: Option<&Vec<Value>>) -> GroqCatalog {
    let mut chat = Vec::new();
    let mut speech = Vec::new();
    for item in models.into_iter().flatten() {
        let Some(id) = item.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let active = item.get("active").and_then(|value| value.as_bool());
        let context_window = item.get("context_window").and_then(|value| value.as_u64());
        let owned_by = item
            .get("owned_by")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let listed = ListedModel {
            id: id.to_string(),
            owned_by,
            context_window,
        };
        if active == Some(false) {
            continue;
        }
        if is_speech_model(id) {
            speech.push(listed);
        } else if is_chat_model(id, context_window) {
            chat.push(listed);
        }
    }
    chat.sort_by(|left, right| left.id.cmp(&right.id));
    speech.sort_by(|left, right| speech_rank(&left.id).cmp(&speech_rank(&right.id)).then(left.id.cmp(&right.id)));
    GroqCatalog { chat, speech }
}

fn is_speech_model(id: &str) -> bool {
    id.to_ascii_lowercase().contains("whisper")
}

fn is_chat_model(id: &str, context_window: Option<u64>) -> bool {
    let id = id.to_ascii_lowercase();
    if is_speech_model(&id) {
        return false;
    }
    const SKIP: &[&str] = &[
        "tts",
        "guard",
        "orpheus",
        "embed",
        "playai",
        "canopylabs",
        "safeguard",
    ];
    if SKIP.iter().any(|part| id.contains(part)) {
        return false;
    }
    if let Some(window) = context_window {
        if window < 4_096 {
            return false;
        }
    }
    true
}

fn speech_rank(id: &str) -> u8 {
    if id == "whisper-large-v3" {
        0
    } else if id.contains("turbo") {
        1
    } else {
        2
    }
}

fn estimate_tokens(messages: &[Value]) -> u64 {
    let chars: usize = messages
        .iter()
        .filter_map(|message| message.get("content").and_then(|value| value.as_str()))
        .map(|text| text.len())
        .sum();
    (chars as u64 / 4).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_chat_models_and_whisper_models() {
        let payload = serde_json::json!([
            {"id": "llama-3.3-70b-versatile", "owned_by": "Meta", "active": true, "context_window": 131072},
            {"id": "whisper-large-v3", "owned_by": "OpenAI", "active": true, "context_window": 448},
            {"id": "whisper-large-v3-turbo", "owned_by": "OpenAI", "active": true, "context_window": 448},
            {"id": "llama-guard-3-8b", "owned_by": "Meta", "active": true, "context_window": 8192},
            {"id": "playai-tts", "owned_by": "PlayAI", "active": true, "context_window": 8192},
            {"id": "canopylabs/orpheus-v1", "owned_by": "Canopy", "active": true, "context_window": 4000},
            {"id": "retired-model", "owned_by": "Meta", "active": false, "context_window": 8192},
            {"id": "qwen/qwen3-32b", "owned_by": "Alibaba Cloud", "active": true, "context_window": 131072}
        ]);
        let catalog = catalog_from_list(payload.as_array());
        assert_eq!(
            catalog.chat.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["llama-3.3-70b-versatile", "qwen/qwen3-32b"]
        );
        assert_eq!(
            catalog.speech.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["whisper-large-v3", "whisper-large-v3-turbo"]
        );
    }
}
