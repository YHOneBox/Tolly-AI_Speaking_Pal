use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DualOutput {
    pub spoken_reply: String,
    pub visual_feedback: Vec<String>,
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

    let spoken_reply = spoken.trim();
    if spoken_reply.is_empty() {
        return Err("The model returned an empty spoken reply.".into());
    }
    let spoken_reply = spoken_reply.chars().take(800).collect::<String>();

    Ok(DualOutput {
        spoken_reply,
        visual_feedback: notes,
    })
}

pub fn canonical_json(output: &DualOutput) -> Result<String, String> {
    serde_json::to_string(&serde_json::json!({
        "spoken_reply": output.spoken_reply,
        "visual_feedback": output.visual_feedback,
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
