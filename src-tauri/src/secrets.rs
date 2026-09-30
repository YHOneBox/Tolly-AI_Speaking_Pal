//! API keys live in an encrypted snapshot beside the executable.
//! The webview never receives them after they are saved.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use tauri_plugin_stronghold::kdf::KeyDerivation;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::error::ApiError;
use crate::paths;

const SERVICE: &str = "com.speakingpal.app";
const GROQ_ACCOUNT: &str = "groq-api-key";
const CARTESIA_ACCOUNT: &str = "cartesia-api-key";
const VAULT_ACCOUNT: &str = "stronghold-password";
const CLIENT_NAME: &[u8] = b"speaking-pal";
const GROQ_RECORD: &str = "groq_api_key";
const CARTESIA_RECORD: &str = "cartesia_api_key";

static VAULT_PASSWORD: Mutex<Option<String>> = Mutex::new(None);
static VAULT_GATE: Mutex<()> = Mutex::new(());
static LEGACY_IMPORTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
pub struct KeyStatus {
    pub groq: bool,
    pub cartesia: bool,
}

pub fn clean_api_key(raw: &str, which: &str) -> Result<String, ApiError> {
    let key = raw.trim();
    if key.len() < 8 || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err(ApiError::bad(format!(
            "The {which} API key does not look valid."
        )));
    }
    Ok(key.to_string())
}

pub fn status() -> Result<KeyStatus, ApiError> {
    with_records(|records| {
        Ok(KeyStatus {
            groq: records.get(GROQ_RECORD)?.is_some(),
            cartesia: records.get(CARTESIA_RECORD)?.is_some(),
        })
    })
}

pub fn groq_key() -> Result<String, ApiError> {
    with_records(|records| {
        records
            .get(GROQ_RECORD)?
            .ok_or(ApiError::MissingKey { which: "Groq" })
    })
}

pub fn cartesia_key() -> Result<String, ApiError> {
    with_records(|records| {
        records
            .get(CARTESIA_RECORD)?
            .ok_or(ApiError::MissingKey { which: "Cartesia" })
    })
}

pub fn save_keys(groq: Option<String>, cartesia: Option<String>) -> Result<(), ApiError> {
    let groq = groq.map(|key| clean_api_key(&key, "Groq")).transpose()?;
    let cartesia = cartesia
        .map(|key| clean_api_key(&key, "Cartesia"))
        .transpose()?;
    with_records(|records| {
        if let Some(key) = groq {
            records.put(GROQ_RECORD, &key)?;
        }
        if let Some(key) = cartesia {
            records.put(CARTESIA_RECORD, &key)?;
        }
        Ok(())
    })
}

pub fn clear_keys() -> Result<(), ApiError> {
    with_records(|records| {
        records.remove(GROQ_RECORD)?;
        records.remove(CARTESIA_RECORD)?;
        Ok(())
    })
}

struct Records {
    stronghold: Stronghold,
    client: iota_stronghold::Client,
}

impl Records {
    fn get(&self, key: &str) -> Result<Option<String>, ApiError> {
        let value = self
            .client
            .store()
            .get(key.as_bytes())
            .map_err(|err| ApiError::storage(err.to_string()))?;
        let Some(bytes) = value else {
            return Ok(None);
        };
        let text = String::from_utf8(bytes)
            .map_err(|err| ApiError::storage(err.to_string()))?
            .trim()
            .to_string();
        if text.is_empty() {
            Ok(None)
        } else {
            Ok(Some(text))
        }
    }

    fn put(&self, key: &str, value: &str) -> Result<(), ApiError> {
        self.client
            .store()
            .insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
            .map_err(|err| ApiError::storage(err.to_string()))?;
        self.stronghold
            .save()
            .map_err(|err| ApiError::storage(err.to_string()))
    }

    fn remove(&self, key: &str) -> Result<(), ApiError> {
        let _ = self
            .client
            .store()
            .delete(key.as_bytes())
            .map_err(|err| ApiError::storage(err.to_string()))?;
        self.stronghold
            .save()
            .map_err(|err| ApiError::storage(err.to_string()))
    }
}

fn with_records<T>(task: impl FnOnce(&Records) -> Result<T, ApiError>) -> Result<T, ApiError> {
    let _guard = VAULT_GATE
        .lock()
        .map_err(|_| ApiError::storage("The key store lock was poisoned."))?;
    let directory = paths::data_dir()?;
    let password = vault_password(&directory)?;
    let snapshot = directory.join("vault.hold");
    let stronghold = open_snapshot(&snapshot, &password, &directory)?;
    let client = match stronghold.load_client(CLIENT_NAME) {
        Ok(client) => client,
        Err(_) => stronghold
            .create_client(CLIENT_NAME)
            .map_err(|err| ApiError::storage(err.to_string()))?,
    };
    let records = Records { stronghold, client };
    if !LEGACY_IMPORTED.load(Ordering::SeqCst) {
        import_legacy_keys(&records)?;
        LEGACY_IMPORTED.store(true, Ordering::SeqCst);
    }
    task(&records)
}

fn open_snapshot(snapshot: &Path, password: &str, directory: &Path) -> Result<Stronghold, ApiError> {
    let hash = KeyDerivation::argon2(password, &directory.join("stronghold.salt"));
    match Stronghold::new(snapshot, hash) {
        Ok(stronghold) => Ok(stronghold),
        Err(err) if snapshot.exists() && stale_snapshot(&err.to_string()) => {
            std::fs::remove_file(snapshot).map_err(|remove_err| ApiError::storage(remove_err.to_string()))?;
            let hash = KeyDerivation::argon2(password, &directory.join("stronghold.salt"));
            Stronghold::new(snapshot, hash).map_err(|retry| ApiError::storage(retry.to_string()))
        }
        Err(err) => Err(ApiError::storage(err.to_string())),
    }
}

fn stale_snapshot(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    text.contains("badfilekey") || text.contains("failed to decode/decrypt") || text.contains("invalid file")
}

fn vault_password(directory: &Path) -> Result<String, ApiError> {
    let mut cached = VAULT_PASSWORD
        .lock()
        .map_err(|_| ApiError::storage("The vault password lock was poisoned."))?;
    if let Some(password) = cached.as_ref() {
        return Ok(password.clone());
    }

    let key_path = directory.join("vault.key");
    let password = if key_path.is_file() {
        std::fs::read_to_string(&key_path)
            .map_err(|err| ApiError::storage(err.to_string()))?
            .trim()
            .to_string()
    } else {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|err| ApiError::storage(err.to_string()))?;
        let created = URL_SAFE_NO_PAD.encode(bytes);
        std::fs::write(&key_path, &created).map_err(|err| ApiError::storage(err.to_string()))?;
        created
    };
    if password.is_empty() {
        return Err(ApiError::storage("The vault key beside Tolly is empty."));
    }
    *cached = Some(password.clone());
    Ok(password)
}

fn import_legacy_keys(records: &Records) -> Result<(), ApiError> {
    if records.get(GROQ_RECORD)?.is_none() {
        if let Some(key) = legacy_secret(GROQ_ACCOUNT)? {
            records.put(GROQ_RECORD, &key)?;
            let _ = legacy_delete(GROQ_ACCOUNT);
        }
    }
    if records.get(CARTESIA_RECORD)?.is_none() {
        if let Some(key) = legacy_secret(CARTESIA_ACCOUNT)? {
            records.put(CARTESIA_RECORD, &key)?;
            let _ = legacy_delete(CARTESIA_ACCOUNT);
        }
    }
    let _ = legacy_delete(VAULT_ACCOUNT);
    Ok(())
}

fn legacy_secret(account: &str) -> Result<Option<String>, ApiError> {
    let entry = match Entry::new(SERVICE, account) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    match entry.get_password() {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Ok(None),
    }
}

fn legacy_delete(account: &str) -> Result<(), ApiError> {
    let Ok(entry) = Entry::new(SERVICE, account) else {
        return Ok(());
    };
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Ok(()),
    }
}
