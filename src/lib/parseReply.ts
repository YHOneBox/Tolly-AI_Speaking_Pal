export type DualOutput = {
  spokenReply: string;
  visualFeedback: string[];
};

export function parseDualOutput(raw: string): DualOutput {
  const fenced = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed: unknown = JSON.parse(fenced);
  if (!isRecord(parsed)) {
    throw new Error("The model reply was not a JSON object.");
  }

  const spoken = parsed.spoken_reply;
  const feedback = parsed.visual_feedback;
  if (typeof spoken !== "string" || !Array.isArray(feedback)) {
    throw new Error("The model reply did not include spoken_reply and visual_feedback.");
  }

  const visualFeedback = feedback.map((item) => {
    if (typeof item !== "string") {
      throw new Error("Each correction must be text.");
    }
    return item;
  });

  const spokenReply = spoken.trim();
  if (!spokenReply) {
    throw new Error("The model returned an empty spoken reply.");
  }

  return { spokenReply, visualFeedback };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
