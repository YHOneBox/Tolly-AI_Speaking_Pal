mod cartesia;
mod commands;
mod dual;
mod error;
mod groq;
mod paths;
mod prefs;
mod prompt;
mod secrets;
mod sse;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

pub struct AppState {
    pub http: reqwest::Client,
    pub speech_generation: Arc<AtomicU64>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .user_agent("Tolly/0.1.0")
        .build()
        .expect("build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState {
            http,
            speech_generation: Arc::new(AtomicU64::new(1)),
        })
        .setup(|app| {
            let data = paths::data_dir().map_err(std::io::Error::other)?;
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or_else(|| std::io::Error::other("Tolly has no window configuration."))?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .data_directory(data.join("webview"))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::save_settings,
            commands::clear_credentials,
            commands::list_voices,
            commands::list_groq_models,
            commands::transcribe,
            commands::converse,
            commands::speak,
            commands::cancel_speech,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
