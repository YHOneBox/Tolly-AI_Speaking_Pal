use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::cartesia;
use crate::error::ApiError;
use crate::groq::{self, HistoryMessage};
use crate::prefs::{self, Preferences, TokenUsage};
use crate::secrets::{self};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub groq_configured: bool,
    pub cartesia_configured: bool,
    pub preferences: Preferences,
    pub usage: TokenUsage,
    pub warning_ratio: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettings {
    pub groq_key: Option<String>,
    pub cartesia_key: Option<String>,
    pub voice_id: String,
    pub llm_model: String,
    pub stt_model: String,
    pub daily_token_budget: u64,
    pub capture_mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResponse {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverseResponse {
    pub raw_json: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens_today: u64,
    pub daily_budget: u64,
    pub budget_warning: bool,
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[tauri::command]
pub fn bootstrap(app: AppHandle) -> Result<Bootstrap, ApiError> {
    let keys = secrets::status()?;
    Ok(Bootstrap {
        groq_configured: keys.groq,
        cartesia_configured: keys.cartesia,
        preferences: prefs::load(&app)?,
        usage: prefs::usage_today(&app)?,
        warning_ratio: 0.8,
    })
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: SaveSettings) -> Result<Bootstrap, ApiError> {
    secrets::save_keys(nonempty(settings.groq_key), nonempty(settings.cartesia_key))?;
    let preferences = Preferences {
        voice_id: settings.voice_id,
        llm_model: settings.llm_model,
        stt_model: settings.stt_model,
        daily_token_budget: settings.daily_token_budget,
        capture_mode: settings.capture_mode,
    };
    prefs::save(&app, &preferences)?;
    bootstrap(app)
}

#[tauri::command]
pub fn clear_credentials(app: AppHandle) -> Result<Bootstrap, ApiError> {
    secrets::clear_keys()?;
    bootstrap(app)
}

#[tauri::command]
pub async fn list_voices(
    state: State<'_, AppState>,
    api_key: Option<String>,
) -> Result<Vec<cartesia::VoiceOption>, ApiError> {
    let http = state.http.clone();
    let api_key = match nonempty(api_key) {
        Some(key) => secrets::clean_api_key(&key, "Cartesia")?,
        None => secrets::cartesia_key()?,
    };
    cartesia::list_voices(&http, &api_key).await
}

#[tauri::command]
pub async fn list_groq_models(
    state: State<'_, AppState>,
    api_key: Option<String>,
) -> Result<groq::GroqCatalog, ApiError> {
    let http = state.http.clone();
    let api_key = match nonempty(api_key) {
        Some(key) => secrets::clean_api_key(&key, "Groq")?,
        None => secrets::groq_key()?,
    };
    groq::list_models(&http, &api_key).await
}

#[tauri::command]
pub async fn transcribe(app: AppHandle, state: State<'_, AppState>, audio: Vec<u8>) -> Result<TranscriptResponse, ApiError> {
    prefs::ensure_budget(&app)?;
    let http = state.http.clone();
    let preferences = prefs::load(&app)?;
    let api_key = secrets::groq_key()?;
    let text = groq::transcribe(&http, &api_key, &preferences.stt_model, audio).await?;
    Ok(TranscriptResponse { text })
}

#[tauri::command]
pub async fn converse(
    app: AppHandle,
    state: State<'_, AppState>,
    history: Vec<HistoryMessage>,
) -> Result<ConverseResponse, ApiError> {
    let (preferences, _) = prefs::ensure_budget(&app)?;
    let http = state.http.clone();
    let api_key = secrets::groq_key()?;
    let result = groq::converse(&http, &api_key, &preferences.llm_model, &history).await?;
    let usage = prefs::add_usage(&app, result.prompt_tokens, result.completion_tokens)?;
    Ok(ConverseResponse {
        raw_json: result.raw_json,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        total_tokens_today: usage.total(),
        daily_budget: preferences.daily_token_budget,
        budget_warning: prefs::budget_warning(&usage, preferences.daily_token_budget),
    })
}

#[tauri::command]
pub async fn speak(
    app: AppHandle,
    state: State<'_, AppState>,
    transcript: String,
    turn_id: String,
) -> Result<(), ApiError> {
    let http = state.http.clone();
    let generation = Arc::clone(&state.speech_generation);
    let generation_at_start = generation.load(Ordering::SeqCst);
    let preferences = prefs::load(&app)?;
    let api_key = secrets::cartesia_key()?;
    cartesia::stream_speech(
        &app,
        &http,
        &api_key,
        &transcript,
        &preferences.voice_id,
        &turn_id,
        &generation,
        generation_at_start,
    )
    .await
}

#[tauri::command]
pub fn cancel_speech(state: State<'_, AppState>) {
    state.speech_generation.fetch_add(1, Ordering::SeqCst);
}
