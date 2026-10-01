export const DEFAULT_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
export const DEFAULT_CHAT_MODEL = "llama-3.3-70b-versatile";
export const DEFAULT_STT_MODEL = "whisper-large-v3";

export type CaptureMode = "vad" | "hold";
export type AppLayout = "center" | "wide" | "split";
export type MicSensitivity = "low" | "normal" | "high";

export type Preferences = {
  voiceId: string;
  llmModel: string;
  sttModel: string;
  dailyTokenBudget: number;
  captureMode: CaptureMode;
  voiceSpeed: number;
  voiceVolume: number;
  fontSize: number;
  layout: AppLayout;
  /** Browser device id of the microphone. Empty means the system default. */
  inputDeviceId: string;
  /** Browser device id of the speaker. Empty means the system default. */
  outputDeviceId: string;
  micSensitivity: MicSensitivity;
};

export type ListedModel = {
  id: string;
  ownedBy: string;
  contextWindow: number | null;
};

export type GroqCatalog = {
  chat: ListedModel[];
  speech: ListedModel[];
};

export const FALLBACK_CHAT_MODELS: ListedModel[] = [
  { id: DEFAULT_CHAT_MODEL, ownedBy: "Meta", contextWindow: 131072 },
  { id: "llama-3.1-8b-instant", ownedBy: "Meta", contextWindow: 131072 },
];

export const FALLBACK_SPEECH_MODELS: ListedModel[] = [
  { id: DEFAULT_STT_MODEL, ownedBy: "OpenAI", contextWindow: null },
];

export type TokenUsage = {
  day: string;
  promptTokens: number;
  completionTokens: number;
};

export type Bootstrap = {
  version: string;
  groqConfigured: boolean;
  cartesiaConfigured: boolean;
  preferences: Preferences;
  usage: TokenUsage;
  warningRatio: number;
};

export type CommandError = {
  code: string;
  message: string;
  retryAfterSecs?: number | null;
  used?: number | null;
  budget?: number | null;
};

export type VoiceOption = {
  id: string;
  name: string;
  language: string;
  description: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  feedback?: string[];
  skillRating?: number | null;
};

export type Phase = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export const DEFAULT_PREFERENCES: Preferences = {
  voiceId: DEFAULT_VOICE_ID,
  llmModel: DEFAULT_CHAT_MODEL,
  sttModel: DEFAULT_STT_MODEL,
  dailyTokenBudget: 100_000,
  captureMode: "vad",
  voiceSpeed: 1,
  voiceVolume: 1,
  fontSize: 16,
  layout: "center",
  inputDeviceId: "",
  outputDeviceId: "",
  micSensitivity: "normal",
};

export function modelLabel(model: ListedModel): string {
  const window =
    model.contextWindow && model.contextWindow >= 1000
      ? ` · ${Math.round(model.contextWindow / 1000)}k`
      : "";
  return `${model.id}${window}`;
}

export function preferModel(models: ListedModel[], current: string, preferred: string): string {
  if (models.some((model) => model.id === current)) {
    return current;
  }
  if (models.some((model) => model.id === preferred)) {
    return preferred;
  }
  return models[0]?.id ?? current;
}

export function normalizeCaptureMode(value: string | undefined): CaptureMode {
  return value === "hold" ? "hold" : "vad";
}

export function normalizeFontSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 16;
  }
  return Math.min(20, Math.max(11, Math.round(value)));
}

export function normalizeSensitivity(value: string | undefined): MicSensitivity {
  return value === "low" || value === "high" ? value : "normal";
}

export function normalizeLayout(value: string | undefined): AppLayout {
  if (value === "wide" || value === "split") {
    return value;
  }
  return "center";
}

export function usageTotal(usage: TokenUsage): number {
  return usage.promptTokens + usage.completionTokens;
}
