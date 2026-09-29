//! API keys and the Stronghold vault password live in the OS credential store
//! (Windows Credential Manager, macOS Keychain, Linux Secret Service).
//! The webview never receives the API keys back after they are saved.

use crate::error::ApiError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;

const SERVICE: &str = "com.speakingpal.app";
const GROQ_ACCOUNT: &str = "groq-api-key";
const CARTESIA_ACCOUNT: &str = "cartesia-api-key";
const VAULT_ACCOUNT: &str = "stronghold-password";

#[derive(Clone, Copy)]
pub struct KeyStatus {
    pub groq: bool,
    pub cartesia: bool,
}

fn entry(account: &str) -> Result<Entry, ApiError> {
    Entry::new(SERVICE, account).map_err(|err| ApiError::storage(err.to_string()))
}

fn read_secret(account: &str) -> Result<Option<String>, ApiError> {
    match entry(account)?.get_password() {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(ApiError::storage(err.to_string())),
    }
}

fn write_secret(account: &str, value: &str) -> Result<(), ApiError> {
    entry(account)?
        .set_password(value)
        .map_err(|err| ApiError::storage(err.to_string()))
}

fn delete_secret(account: &str) -> Result<(), ApiError> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(ApiError::storage(err.to_string())),
    }
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
    Ok(KeyStatus {
        groq: read_secret(GROQ_ACCOUNT)?.is_some(),
        cartesia: read_secret(CARTESIA_ACCOUNT)?.is_some(),
    })
}

pub fn groq_key() -> Result<String, ApiError> {
    read_secret(GROQ_ACCOUNT)?
        .ok_or(ApiError::MissingKey { which: "Groq" })
}

pub fn cartesia_key() -> Result<String, ApiError> {
    read_secret(CARTESIA_ACCOUNT)?.ok_or(ApiError::MissingKey { which: "Cartesia" })
}

pub fn save_keys(groq: Option<String>, cartesia: Option<String>) -> Result<(), ApiError> {
    if let Some(key) = groq {
        let key = clean_api_key(&key, "Groq")?;
        write_secret(GROQ_ACCOUNT, &key)?;
    }
    if let Some(key) = cartesia {
        let key = clean_api_key(&key, "Cartesia")?;
        write_secret(CARTESIA_ACCOUNT, &key)?;
    }
    Ok(())
}

pub fn clear_keys() -> Result<(), ApiError> {
    delete_secret(GROQ_ACCOUNT)?;
    delete_secret(CARTESIA_ACCOUNT)?;
    Ok(())
}

pub fn vault_password() -> Result<String, ApiError> {
    if let Some(existing) = read_secret(VAULT_ACCOUNT)? {
        return Ok(existing);
    }

    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|err| ApiError::storage(err.to_string()))?;
    let password = URL_SAFE_NO_PAD.encode(bytes);
    write_secret(VAULT_ACCOUNT, &password)?;
    Ok(password)
}
