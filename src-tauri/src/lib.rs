mod cartesia;
mod commands;
mod dual;
mod error;
mod groq;
mod prefs;
mod prompt;
mod secrets;
mod sse;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

pub struct AppState {
    pub http: reqwest::Client,
    pub speech_generation: Arc<AtomicU64>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .user_agent("ai-speaking-pal/0.1.0")
        .build()
        .expect("build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState {
            http,
            speech_generation: Arc::new(AtomicU64::new(1)),
        })
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let salt_path = directory.join("stronghold.salt");
            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::save_settings,
            commands::clear_credentials,
            commands::stronghold_unlock,
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
