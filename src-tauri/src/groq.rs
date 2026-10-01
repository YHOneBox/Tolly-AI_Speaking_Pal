use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dual::{canonical_json, parse_dual_output};
use crate::error::{ensure_success, ApiError};
use crate::prompt::SYSTEM_PROMPT;
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
        .text("model", model.to_string())
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
    let mut last_error = None;
    for attempt in 0..2 {
        let temperature = if attempt == 0 { 0.7 } else { 0.2 };
        match complete_json(http, api_key, model, &messages, temperature).await {
            Ok(result) => return Ok(result),
            Err(error) if matches!(error, ApiError::InvalidModelOutput { .. }) && attempt == 0 => {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| ApiError::InvalidModelOutput {
        message: "The model returned an empty response.".into(),
    }))
}

async fn complete_json(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[Value],
    temperature: f64,
) -> Result<LlmResult, ApiError> {
    // JSON mode on Groq often returns an empty body when the request is streamed,
    // especially on the turn after the first reply. The spoken line is not played
    // until the whole object is parsed, so a single response is the reliable path.
    let response = http
        .post(GROQ_CHAT_URL)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "temperature": temperature,
            "max_tokens": 800,
            "stream": false,
            "response_format": { "type": "json_object" },
            "messages": messages,
        }))
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let response = ensure_success(response).await?;
    let payload: Value = response
        .json()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;

    let content = message_text(&payload);
    if content.trim().is_empty() {
        return Err(ApiError::InvalidModelOutput {
            message: "The model returned an empty response.".into(),
        });
    }

    let output = parse_dual_output(&content).map_err(|message| ApiError::InvalidModelOutput { message })?;
    let raw_json = canonical_json(&output).map_err(|message| ApiError::InvalidModelOutput { message })?;
    let prompt_tokens = payload
        .pointer("/usage/prompt_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or_else(|| estimate_tokens(messages));
    let completion_tokens = payload
        .pointer("/usage/completion_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or_else(|| (raw_json.len() as u64 / 4).max(1));

    Ok(LlmResult {
        raw_json,
        prompt_tokens,
        completion_tokens,
    })
}

pub(crate) fn message_text(payload: &Value) -> String {
    let message = payload.pointer("/choices/0/message");
    let content = message
        .and_then(|item| item.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if !content.is_empty() {
        return content.to_string();
    }
    if let Some(message) = message {
        for key in ["reasoning", "reasoning_content"] {
            let Some(text) = message.get(key).and_then(|value| value.as_str()) else {
                continue;
            };
            if let Some(json) = extract_json_object(text) {
                return json;
            }
        }
    }
    String::new()
}

fn extract_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(text[start..=end].to_string())
}

fn build_messages(history: &[HistoryMessage]) -> Result<Vec<Value>, ApiError> {
    if history.is_empty() {
        return Err(ApiError::bad("Say or type something first."));
    }

    let mut messages = vec![json!({
        "role": "system",
        "content": SYSTEM_PROMPT,
    })];
    let start = history.len().saturating_sub(8);
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

    #[test]
    fn reads_json_from_the_message_body() {
        let payload = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "{\"spoken_reply\":\"Hey.\",\"visual_feedback\":[],\"skill_rating\":null}"
                }
            }]
        });
        assert!(message_text(&payload).contains("spoken_reply"));
    }

    #[test]
    fn recovers_json_when_the_visible_content_is_empty() {
        let payload = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "",
                    "reasoning": "draft {\"spoken_reply\":\"Yeah, the cafe.\",\"visual_feedback\":[],\"skill_rating\":70}"
                }
            }]
        });
        let text = message_text(&payload);
        assert!(text.starts_with('{'));
        assert!(text.contains("Yeah, the cafe."));
    }
}
