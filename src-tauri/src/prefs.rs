//! Non-secret preferences and the local token ledger.
//! API keys must never be written to this store.
//! The file lives in the data folder next to the executable.

use crate::error::ApiError;
use crate::paths;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "settings.json";
pub const DEFAULT_VOICE_ID: &str = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
pub const DEFAULT_MODEL: &str = "llama-3.3-70b-versatile";
pub const DEFAULT_STT_MODEL: &str = "whisper-large-v3";
const WARNING_PERCENT: u64 = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub voice_id: String,
    pub llm_model: String,
    #[serde(default = "default_stt_model")]
    pub stt_model: String,
    pub daily_token_budget: u64,
    #[serde(default = "default_capture_mode")]
    pub capture_mode: String,
}

fn default_capture_mode() -> String {
    "vad".to_string()
}

fn default_stt_model() -> String {
    DEFAULT_STT_MODEL.to_string()
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            voice_id: DEFAULT_VOICE_ID.to_string(),
            llm_model: DEFAULT_MODEL.to_string(),
            stt_model: default_stt_model(),
            daily_token_budget: 100_000,
            capture_mode: default_capture_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenUsage {
    pub day: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

impl Default for TokenUsage {
    fn default() -> Self {
        Self {
            day: today(),
            prompt_tokens: 0,
            completion_tokens: 0,
        }
    }
}

impl TokenUsage {
    pub fn total(&self) -> u64 {
        self.prompt_tokens.saturating_add(self.completion_tokens)
    }
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn open<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<std::sync::Arc<tauri_plugin_store::Store<R>>, ApiError> {
    let path = paths::data_dir()?.join(STORE_FILE);
    if !path.exists() {
        if let Ok(legacy_dir) = app.path().app_data_dir() {
            let legacy = legacy_dir.join(STORE_FILE);
            if legacy.is_file() {
                let _ = std::fs::copy(&legacy, &path);
            }
        }
    }
    app.store(path)
        .map_err(|err| ApiError::storage(err.to_string()))
}

fn read_json<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<Option<Value>, ApiError> {
    Ok(open(app)?.get(key))
}

fn write_json<R: Runtime>(app: &AppHandle<R>, key: &str, value: &impl Serialize) -> Result<(), ApiError> {
    let store = open(app)?;
    let json = serde_json::to_value(value).map_err(|err| ApiError::storage(err.to_string()))?;
    store.set(key, json);
    store
        .save()
        .map_err(|err| ApiError::storage(err.to_string()))
}

pub fn validate(prefs: &Preferences) -> Result<(), ApiError> {
    validate_voice(&prefs.voice_id)?;
    validate_model_id(&prefs.llm_model)?;
    validate_model_id(&prefs.stt_model)?;
    if !(1_000..=2_000_000).contains(&prefs.daily_token_budget) {
        return Err(ApiError::bad(
            "The daily token budget must be between 1,000 and 2,000,000.",
        ));
    }
    if prefs.capture_mode != "vad" && prefs.capture_mode != "hold" {
        return Err(ApiError::bad(
            "Choose voice detection or hold to speak.",
        ));
    }
    Ok(())
}

pub fn validate_model_id(model: &str) -> Result<(), ApiError> {
    let valid = (1..=128).contains(&model.len())
        && model
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'));
    if !valid {
        return Err(ApiError::bad("Choose a model from the list for this API key."));
    }
    Ok(())
}

pub fn validate_voice(voice_id: &str) -> Result<(), ApiError> {
    let valid = voice_id.len() >= 8
        && voice_id.len() <= 80
        && voice_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if !valid {
        return Err(ApiError::bad("Choose a voice from the Cartesia list."));
    }
    Ok(())
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Preferences, ApiError> {
    let mut prefs = match read_json(app, "preferences")? {
        Some(value) => serde_json::from_value(value).unwrap_or_else(|_| Preferences::default()),
        None => Preferences::default(),
    };
    if validate_voice(&prefs.voice_id).is_err() {
        prefs.voice_id = DEFAULT_VOICE_ID.to_string();
    }
    if validate_model_id(&prefs.llm_model).is_err() {
        prefs.llm_model = DEFAULT_MODEL.to_string();
    }
    if validate_model_id(&prefs.stt_model).is_err() {
        prefs.stt_model = default_stt_model();
    }
    if !(1_000..=2_000_000).contains(&prefs.daily_token_budget) {
        prefs.daily_token_budget = Preferences::default().daily_token_budget;
    }
    if prefs.capture_mode != "vad" && prefs.capture_mode != "hold" {
        prefs.capture_mode = default_capture_mode();
    }
    Ok(prefs)
}

pub fn save<R: Runtime>(app: &AppHandle<R>, prefs: &Preferences) -> Result<(), ApiError> {
    validate(prefs)?;
    write_json(app, "preferences", prefs)
}

pub fn usage_today<R: Runtime>(app: &AppHandle<R>) -> Result<TokenUsage, ApiError> {
    let usage = match read_json(app, "tokenUsage")? {
        Some(value) => serde_json::from_value(value).unwrap_or_default(),
        None => TokenUsage::default(),
    };
    if usage.day != today() {
        let reset = TokenUsage::default();
        write_json(app, "tokenUsage", &reset)?;
        return Ok(reset);
    }
    Ok(usage)
}

pub fn ensure_budget<R: Runtime>(app: &AppHandle<R>) -> Result<(Preferences, TokenUsage), ApiError> {
    let prefs = load(app)?;
    let usage = usage_today(app)?;
    if usage.total() >= prefs.daily_token_budget {
        return Err(ApiError::BudgetExceeded {
            used: usage.total(),
            budget: prefs.daily_token_budget,
        });
    }
    Ok((prefs, usage))
}

pub fn add_usage<R: Runtime>(
    app: &AppHandle<R>,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> Result<TokenUsage, ApiError> {
    let mut usage = usage_today(app)?;
    usage.prompt_tokens = usage.prompt_tokens.saturating_add(prompt_tokens);
    usage.completion_tokens = usage.completion_tokens.saturating_add(completion_tokens);
    write_json(app, "tokenUsage", &usage)?;
    Ok(usage)
}

pub fn budget_warning(usage: &TokenUsage, budget: u64) -> bool {
    if budget == 0 {
        return true;
    }
    usage.total().saturating_mul(100) / budget >= WARNING_PERCENT
}
