use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("Add your {which} API key in Settings.")]
    MissingKey { which: &'static str },
    #[error("{message}")]
    RateLimited {
        message: String,
        retry_after_secs: Option<u64>,
    },
    #[error("Today's token budget is used up ({used} of {budget}).")]
    BudgetExceeded { used: u64, budget: u64 },
    #[error("{message}")]
    InvalidModelOutput { message: String },
    #[error("{message}")]
    Upstream { status: u16, message: String },
    #[error("{message}")]
    Storage { message: String },
    #[error("{message}")]
    BadRequest { message: String },
}

impl ApiError {
    pub fn storage(message: impl Into<String>) -> Self {
        Self::Storage {
            message: message.into(),
        }
    }

    pub fn bad(message: impl Into<String>) -> Self {
        Self::BadRequest {
            message: message.into(),
        }
    }

    pub fn upstream(status: u16, message: impl Into<String>) -> Self {
        Self::Upstream {
            status,
            message: message.into(),
        }
    }
}

impl Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let (code, message, retry_after_secs, used, budget) = match self {
            Self::MissingKey { which } => (
                "missing_key",
                format!("Add your {which} API key in Settings."),
                None,
                None,
                None,
            ),
            Self::RateLimited {
                message,
                retry_after_secs,
            } => ("rate_limited", message.clone(), *retry_after_secs, None, None),
            Self::BudgetExceeded { used, budget } => (
                "budget_exceeded",
                format!("Today's token budget is used up ({used} of {budget}). Raise it in Settings or wait until tomorrow."),
                None,
                Some(*used),
                Some(*budget),
            ),
            Self::InvalidModelOutput { message } => {
                ("invalid_model_output", message.clone(), None, None, None)
            }
            Self::Upstream { status, message } => (
                "upstream",
                format!("The service returned {status}. {message}"),
                None,
                None,
                None,
            ),
            Self::Storage { message } => ("storage", message.clone(), None, None, None),
            Self::BadRequest { message } => ("bad_request", message.clone(), None, None, None),
        };

        let mut state = serializer.serialize_struct("ApiError", 5)?;
        state.serialize_field("code", code)?;
        state.serialize_field("message", &message)?;
        state.serialize_field("retryAfterSecs", &retry_after_secs)?;
        state.serialize_field("used", &used)?;
        state.serialize_field("budget", &budget)?;
        state.end()
    }
}

pub fn truncate_message(input: &str) -> String {
    let trimmed = input.trim();
    let mut out = trimmed.chars().take(400).collect::<String>();
    if trimmed.chars().count() > 400 {
        out.push('…');
    }
    if out.is_empty() {
        "The request failed.".to_string()
    } else {
        out
    }
}

pub fn message_from_body(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
        {
            return truncate_message(message);
        }
        if let Some(message) = value.get("message").and_then(|message| message.as_str()) {
            return truncate_message(message);
        }
    }
    truncate_message(body)
}

pub fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

pub async fn ensure_success(response: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status().as_u16();
    let retry_after_secs = retry_after_seconds(response.headers());
    let body = response.text().await.unwrap_or_default();
    let message = message_from_body(&body);

    if status == 429 {
        return Err(ApiError::RateLimited {
            message: if message.is_empty() {
                "Too many requests.".into()
            } else {
                message
            },
            retry_after_secs,
        });
    }

    if status == 401 || status == 403 {
        return Err(ApiError::BadRequest {
            message: format!("The API key was rejected. {message}"),
        });
    }

    Err(ApiError::upstream(status, message))
}
