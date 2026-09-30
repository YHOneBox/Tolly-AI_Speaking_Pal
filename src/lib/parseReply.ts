export type DualOutput = {
  spokenReply: string;
  visualFeedback: string[];
  skillRating: number | null;
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

  return { spokenReply, visualFeedback, skillRating: readSkillRating(parsed.skill_rating) };
}

export function speakingBand(score: number): string {
  if (score >= 90) {
    return "Easy";
  }
  if (score >= 75) {
    return "Natural";
  }
  if (score >= 60) {
    return "Clear";
  }
  if (score >= 40) {
    return "Getting there";
  }
  return "Finding words";
}

export function blendSkill(current: number | null, next: number): number {
  if (current === null) {
    return next;
  }
  return Math.round(current * 0.7 + next * 0.3);
}

export function estimateSkill(noteCount: number): number {
  return Math.min(92, Math.max(30, 86 - noteCount * 14));
}

function readSkillRating(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
