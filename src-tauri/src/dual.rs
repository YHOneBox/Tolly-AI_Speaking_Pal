use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DualOutput {
    pub spoken_reply: String,
    pub visual_feedback: Vec<String>,
    pub skill_rating: Option<u8>,
}

pub fn parse_dual_output(raw: &str) -> Result<DualOutput, String> {
    let trimmed = raw.trim();
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim();
    let json_text = without_open
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim();

    let value: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|_| "The model did not return the expected JSON object.".to_string())?;

    let spoken = value
        .get("spoken_reply")
        .and_then(|item| item.as_str())
        .ok_or_else(|| "The model reply is missing spoken_reply.".to_string())?;
    let feedback = value
        .get("visual_feedback")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "The model reply is missing visual_feedback.".to_string())?;

    let mut notes = Vec::new();
    for item in feedback {
        let note = item
            .as_str()
            .ok_or_else(|| "Each correction must be a string.".to_string())?
            .trim();
        if !note.is_empty() {
            notes.push(note.to_string());
        }
    }
    notes.truncate(4);

    let skill_rating = parse_skill_rating(&value);
    let spoken_reply = spoken.trim();
    if spoken_reply.is_empty() {
        return Err("The model returned an empty spoken reply.".into());
    }
    let spoken_reply = spoken_reply.chars().take(800).collect::<String>();

    Ok(DualOutput {
        spoken_reply,
        visual_feedback: notes,
        skill_rating,
    })
}

fn parse_skill_rating(value: &serde_json::Value) -> Option<u8> {
    let raw = value.get("skill_rating")?;
    if raw.is_null() {
        return None;
    }
    let number = raw.as_f64()?;
    if !number.is_finite() {
        return None;
    }
    Some(number.round().clamp(0.0, 100.0) as u8)
}

pub fn canonical_json(output: &DualOutput) -> Result<String, String> {
    serde_json::to_string(&serde_json::json!({
        "spoken_reply": output.spoken_reply,
        "visual_feedback": output.visual_feedback,
        "skill_rating": output.skill_rating,
    }))
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_strict_object() {
        let raw = r#"{"spoken_reply":"I went yesterday.","visual_feedback":["Say \"went\" instead of \"goed\"."]}"#;
        let parsed = parse_dual_output(raw).unwrap();
        assert_eq!(parsed.spoken_reply, "I went yesterday.");
        assert_eq!(parsed.visual_feedback.len(), 1);
        assert_eq!(parsed.skill_rating, None);
    }

    #[test]
    fn keeps_a_conversation_skill_rating() {
        let raw = r#"{"spoken_reply":"Yeah, that cafe is good.","visual_feedback":[],"skill_rating":82.4}"#;
        let parsed = parse_dual_output(raw).unwrap();
        assert_eq!(parsed.skill_rating, Some(82));
    }

    #[test]
    fn clamps_a_skill_rating() {
        let raw = r#"{"spoken_reply":"Hello.","visual_feedback":[],"skill_rating":140}"#;
        let parsed = parse_dual_output(raw).unwrap();
        assert_eq!(parsed.skill_rating, Some(100));
    }

    #[test]
    fn strips_json_fences() {
        let raw = "```json\n{\"spoken_reply\":\"Hello.\",\"visual_feedback\":[]}\n```";
        let parsed = parse_dual_output(raw).unwrap();
        assert_eq!(parsed.spoken_reply, "Hello.");
        assert!(parsed.visual_feedback.is_empty());
    }

    #[test]
    fn rejects_missing_feedback_array() {
        let raw = r#"{"spoken_reply":"Hello."}"#;
        assert!(parse_dual_output(raw).is_err());
    }
}
