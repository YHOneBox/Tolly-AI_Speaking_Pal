import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Bootstrap, GroqCatalog, Preferences, VoiceOption } from "../types";
import { isDesktopShell } from "./errors";

export type ConverseResult = {
  rawJson: string;
  promptTokens: number;
  completionTokens: number;
  totalTokensToday: number;
  dailyBudget: number;
  budgetWarning: boolean;
};

export type TtsChunk = {
  turnId: string;
  seq: number;
  sampleRate: number;
  encoding: string;
  dataBase64: string;
};

function assertDesktop(): void {
  if (!isDesktopShell()) {
    throw new Error("Open the desktop app to use keys, transcription, and voice.");
  }
}

export async function bootstrap(): Promise<Bootstrap> {
  assertDesktop();
  return invoke<Bootstrap>("bootstrap");
}

export async function saveSettings(input: {
  groqKey?: string;
  cartesiaKey?: string;
  preferences: Preferences;
}): Promise<Bootstrap> {
  assertDesktop();
  return invoke<Bootstrap>("save_settings", {
    settings: {
      groqKey: input.groqKey ?? null,
      cartesiaKey: input.cartesiaKey ?? null,
      voiceId: input.preferences.voiceId,
      llmModel: input.preferences.llmModel,
      sttModel: input.preferences.sttModel,
      dailyTokenBudget: input.preferences.dailyTokenBudget,
      captureMode: input.preferences.captureMode,
    },
  });
}

export async function clearCredentials(): Promise<Bootstrap> {
  assertDesktop();
  return invoke<Bootstrap>("clear_credentials");
}

export async function listVoices(apiKey?: string): Promise<VoiceOption[]> {
  assertDesktop();
  return invoke<VoiceOption[]>("list_voices", { apiKey: apiKey ?? null });
}

export async function listGroqModels(apiKey?: string): Promise<GroqCatalog> {
  assertDesktop();
  return invoke<GroqCatalog>("list_groq_models", { apiKey: apiKey ?? null });
}

export async function transcribe(audio: Uint8Array): Promise<string> {
  assertDesktop();
  const response = await invoke<{ text: string }>("transcribe", {
    audio: Array.from(audio),
  });
  return response.text;
}

export async function converse(history: { role: "user" | "assistant"; content: string }[]): Promise<ConverseResult> {
  assertDesktop();
  return invoke<ConverseResult>("converse", { history });
}

export async function speak(
  transcript: string,
  turnId: string,
  onChunk: (chunk: TtsChunk) => void,
): Promise<void> {
  assertDesktop();
  const unlisten: UnlistenFn = await listen<TtsChunk>("tts-chunk", (event) => {
    if (event.payload.turnId === turnId) {
      onChunk(event.payload);
    }
  });
  try {
    await invoke("speak", { transcript, turnId });
  } finally {
    unlisten();
  }
}

export async function cancelSpeech(): Promise<void> {
  if (!isDesktopShell()) {
    return;
  }
  await invoke("cancel_speech");
}
