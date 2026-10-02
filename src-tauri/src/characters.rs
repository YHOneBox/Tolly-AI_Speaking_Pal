//! Generated conversation partners. Each one is a short profile the model plays.
//! Profiles live in the settings store next to the preferences; the built-in Tolly is not stored.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::error::ApiError;
use crate::prefs;

const STORE_KEY: &str = "characters";
const ACTIVE_KEY: &str = "activeCharacterId";
pub const MAX_CHARACTERS: usize = 12;
pub const MAX_PROMPT_CHARS: usize = 600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Character {
    pub id: String,
    pub name: String,
    /// One short line under the name.
    pub tagline: String,
    /// Two or three sentences about who they are, in the third person.
    pub description: String,
    /// A few traits, comma separated.
    pub personality: String,
    /// How they talk: pace, favourite words, habits.
    pub speaking_style: String,
    /// The kind of thing they say first.
    pub greeting: String,
    /// One emoji used as the avatar.
    pub emoji: String,
    /// What the user asked for. Kept so the card can show it.
    pub prompt: String,
    pub created_at: String,
}

impl Default for Character {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            tagline: String::new(),
            description: String::new(),
            personality: String::new(),
            speaking_style: String::new(),
            greeting: String::new(),
            emoji: "🙂".to_string(),
            prompt: String::new(),
            created_at: String::new(),
        }
    }
}

impl Character {
    /// The persona paragraph that replaces the built-in friend in the system prompt.
    pub fn persona(&self) -> String {
        let mut text = format!(
            "You are {name}, a real person sitting with someone and talking. {description} ",
            name = self.name,
            description = self.description.trim(),
        );
        if !self.personality.trim().is_empty() {
            text.push_str(&format!("You are {}. ", self.personality.trim().trim_end_matches('.')));
        }
        if !self.speaking_style.trim().is_empty() {
            text.push_str(&format!("How you talk: {} ", self.speaking_style.trim()));
        }
        if !self.greeting.trim().is_empty() {
            text.push_str(&format!(
                "When you greet someone you tend to open the way you would say: \"{}\" ",
                self.greeting.trim()
            ));
        }
        text.push_str(
            "Stay in character the whole time. You are not a tutor, teacher, interviewer, or assistant. \
             You sound like a real person: contractions, small reactions, opinions, and the occasional unfinished thought. ",
        );
        text
    }
}

/// What the model is asked when it writes a new character.
pub const GENERATOR_PROMPT: &str = concat!(
    "You design conversation partners for casual spoken English practice. The user describes who they would like to talk to. ",
    "Invent one believable person who fits: a real human with an ordinary life, never an AI, robot, assistant, teacher, or tutor. ",
    "Keep everything friendly and safe for all ages. ",
    "Reply with one JSON object and nothing else, with exactly these keys:\n",
    "- \"name\": string, a first name or a short nickname, at most 24 characters.\n",
    "- \"tagline\": string, one short line that sums them up, at most 60 characters, no full stop.\n",
    "- \"description\": string, two or three sentences about who they are, in the third person, at most 400 characters.\n",
    "- \"personality\": string, three to five traits separated by commas, lower case.\n",
    "- \"speaking_style\": string, one or two sentences about how they talk, at most 240 characters.\n",
    "- \"greeting\": string, the first thing they would say when a friend sits down, one or two sentences, at most 160 characters.\n",
    "- \"emoji\": string, exactly one emoji that suits them.\n",
    "Do not add other keys. Do not wrap the JSON in markdown."
);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CharacterState {
    pub characters: Vec<Character>,
    /// Empty when the built-in Tolly is active.
    pub active_character_id: String,
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<CharacterState, ApiError> {
    let characters: Vec<Character> = match prefs::read_json(app, STORE_KEY)? {
        Some(value) => serde_json::from_value::<Vec<Character>>(value)
            .unwrap_or_default()
            .into_iter()
            .filter(|character| !character.id.is_empty() && !character.name.is_empty())
            .collect(),
        None => Vec::new(),
    };
    let active = match prefs::read_json(app, ACTIVE_KEY)? {
        Some(Value::String(id)) if characters.iter().any(|character| character.id == id) => id,
        _ => String::new(),
    };
    Ok(CharacterState {
        characters,
        active_character_id: active,
    })
}

/// The active character, or `None` when the built-in Tolly is talking.
pub fn active<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Character>, ApiError> {
    let state = load(app)?;
    Ok(state
        .characters
        .into_iter()
        .find(|character| character.id == state.active_character_id))
}

pub fn add<R: Runtime>(app: &AppHandle<R>, character: Character) -> Result<CharacterState, ApiError> {
    let mut state = load(app)?;
    if state.characters.len() >= MAX_CHARACTERS {
        return Err(ApiError::bad(format!(
            "You can keep up to {MAX_CHARACTERS} characters. Remove one first."
        )));
    }
    state.active_character_id = character.id.clone();
    state.characters.push(character);
    save(app, &state)?;
    Ok(state)
}

pub fn set_active<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<CharacterState, ApiError> {
    let mut state = load(app)?;
    if !id.is_empty() && !state.characters.iter().any(|character| character.id == id) {
        return Err(ApiError::bad("That character is no longer saved."));
    }
    state.active_character_id = id.to_string();
    save(app, &state)?;
    Ok(state)
}

pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<CharacterState, ApiError> {
    if id.is_empty() {
        return Err(ApiError::bad("Tolly is built in and cannot be removed."));
    }
    let mut state = load(app)?;
    let before = state.characters.len();
    state.characters.retain(|character| character.id != id);
    if state.characters.len() == before {
        return Err(ApiError::bad("That character is no longer saved."));
    }
    if state.active_character_id == id {
        state.active_character_id.clear();
    }
    save(app, &state)?;
    Ok(state)
}

fn save<R: Runtime>(app: &AppHandle<R>, state: &CharacterState) -> Result<(), ApiError> {
    prefs::write_json(app, STORE_KEY, &state.characters)?;
    prefs::write_json(app, ACTIVE_KEY, &state.active_character_id)
}

pub fn clean_prompt(prompt: &str) -> Result<String, ApiError> {
    let trimmed = prompt.trim();
    if trimmed.chars().count() < 3 {
        return Err(ApiError::bad("Describe the person you would like to talk to, in a few words or more."));
    }
    if trimmed.chars().count() > MAX_PROMPT_CHARS {
        return Err(ApiError::bad(format!(
            "Keep the description under {MAX_PROMPT_CHARS} characters."
        )));
    }
    Ok(trimmed.to_string())
}

/// Turns the model's JSON into a stored character, trimming anything too long.
pub fn from_model_output(raw: &str, prompt: &str, id: String, created_at: String) -> Result<Character, String> {
    let value: Value = serde_json::from_str(raw.trim()).map_err(|err| format!("The character was not valid JSON: {err}"))?;
    let text = |key: &str, max: usize| -> String {
        let raw = value.get(key).and_then(|item| item.as_str()).unwrap_or("").trim();
        clip(raw, max)
    };
    let name = text("name", 24);
    if name.is_empty() {
        return Err("The character has no name.".to_string());
    }
    let description = text("description", 400);
    if description.is_empty() {
        return Err("The character has no description.".to_string());
    }
    let emoji = first_emoji(value.get("emoji").and_then(|item| item.as_str()).unwrap_or(""));
    Ok(Character {
        id,
        name,
        tagline: text("tagline", 60).trim_end_matches('.').to_string(),
        description,
        personality: text("personality", 160),
        speaking_style: text("speaking_style", 240),
        greeting: text("greeting", 160),
        emoji,
        prompt: clip(prompt, MAX_PROMPT_CHARS),
        created_at,
    })
}

fn clip(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let mut out: String = input.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// The first non-ASCII character cluster of the string, or a default smile.
fn first_emoji(input: &str) -> String {
    let mut out = String::new();
    for ch in input.trim().chars() {
        if ch.is_ascii() {
            if out.is_empty() {
                continue;
            }
            break;
        }
        // Keep variation selectors and joiners attached to the first symbol.
        let joiner = ch == '\u{200D}' || ('\u{FE00}'..='\u{FE0F}').contains(&ch) || ('\u{1F3FB}'..='\u{1F3FF}').contains(&ch);
        if !out.is_empty() && !joiner && !out.ends_with('\u{200D}') {
            break;
        }
        out.push(ch);
        if out.chars().count() > 8 {
            break;
        }
    }
    if out.is_empty() {
        "🙂".to_string()
    } else {
        out
    }
}

/// A short unique id from the clock and a few random bytes.
pub fn new_id() -> String {
    let mut bytes = [0u8; 6];
    let _ = getrandom::getrandom(&mut bytes);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "c{:x}{}",
        nanos % 0xFFFF_FFFF,
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_character_from_model_json() {
        let raw = r#"{"name":"Mara","tagline":"Harbour pilot who never stops talking about boats.","description":"Mara guides ships into a small northern harbour. She has a dog named Biscuit.","personality":"warm, blunt, curious","speaking_style":"Short sentences. Says 'right then' a lot.","greeting":"Right then, pull up a chair. Did you see that fog this morning?","emoji":"⚓"}"#;
        let character = from_model_output(raw, "a sailor", "c1".into(), "2026-10-01".into()).unwrap();
        assert_eq!(character.name, "Mara");
        assert_eq!(character.tagline, "Harbour pilot who never stops talking about boats");
        assert_eq!(character.emoji, "⚓");
        assert_eq!(character.prompt, "a sailor");
        let persona = character.persona();
        assert!(persona.starts_with("You are Mara, a real person"));
        assert!(persona.contains("Biscuit"));
        assert!(persona.contains("You are warm, blunt, curious."));
        assert!(persona.contains("Right then, pull up a chair."));
        assert!(persona.contains("not a tutor"));
    }

    #[test]
    fn clips_long_fields_and_fills_a_missing_emoji() {
        let long = "x".repeat(900);
        let raw = format!(r#"{{"name":"{}","description":"{}","emoji":"ok"}}"#, "N".repeat(50), long);
        let character = from_model_output(&raw, "p", "c2".into(), String::new()).unwrap();
        assert_eq!(character.name.chars().count(), 25);
        assert!(character.name.ends_with('…'));
        assert_eq!(character.description.chars().count(), 401);
        assert_eq!(character.emoji, "🙂");
    }

    #[test]
    fn rejects_output_without_a_name_or_description() {
        assert!(from_model_output(r#"{"description":"Someone."}"#, "p", "c".into(), String::new()).is_err());
        assert!(from_model_output(r#"{"name":"Al"}"#, "p", "c".into(), String::new()).is_err());
        assert!(from_model_output("not json", "p", "c".into(), String::new()).is_err());
    }

    #[test]
    fn keeps_a_composed_emoji_together() {
        assert_eq!(first_emoji("👩‍🚀 astronaut"), "👩‍🚀");
        assert_eq!(first_emoji("  🎸"), "🎸");
        assert_eq!(first_emoji("🎸🎹"), "🎸");
        assert_eq!(first_emoji(""), "🙂");
    }

    #[test]
    fn prompts_must_be_a_few_words() {
        assert!(clean_prompt("  ").is_err());
        assert!(clean_prompt(&"a".repeat(MAX_PROMPT_CHARS + 1)).is_err());
        assert_eq!(clean_prompt("  a chef from Lisbon ").unwrap(), "a chef from Lisbon");
    }

    #[test]
    fn ids_are_unique_enough() {
        let a = new_id();
        let b = new_id();
        assert!(a.starts_with('c'));
        assert_ne!(a, b);
    }
}
