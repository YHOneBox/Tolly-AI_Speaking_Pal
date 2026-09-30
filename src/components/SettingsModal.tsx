import { useEffect, useId, useRef, useState } from "react";

import { clearCredentials, listGroqModels, listVoices, saveSettings } from "../lib/api";
import { isDesktopShell, toCommandError } from "../lib/errors";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_STT_MODEL,
  DEFAULT_VOICE_ID,
  FALLBACK_CHAT_MODELS,
  FALLBACK_SPEECH_MODELS,
  modelLabel,
  preferModel,
  type Bootstrap,
  type ListedModel,
  type Preferences,
  type VoiceOption,
} from "../types";

type SettingsModalProps = {
  session: Bootstrap;
  onClose: () => void;
  onSession: (session: Bootstrap) => void;
};

export function SettingsModal({ session, onClose, onSession }: SettingsModalProps) {
  const titleId = useId();
  const [groqKey, setGroqKey] = useState("");
  const [cartesiaKey, setCartesiaKey] = useState("");
  const [preferences, setPreferences] = useState<Preferences>(session.preferences);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [chatModels, setChatModels] = useState<ListedModel[]>([]);
  const [speechModels, setSpeechModels] = useState<ListedModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const desktop = isDesktopShell();
  const fetchedGroq = useRef("");
  const fetchedCartesia = useRef("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!desktop || !session.groqConfigured) {
      return;
    }
    void loadGroqModels();
  }, [desktop, session.groqConfigured]);

  useEffect(() => {
    if (!desktop) {
      return;
    }
    const key = groqKey.trim();
    if (key.length < 20) {
      return;
    }
    const handle = window.setTimeout(() => {
      void loadGroqModels(key);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [desktop, groqKey]);

  useEffect(() => {
    if (!desktop || !session.cartesiaConfigured) {
      return;
    }
    void loadVoiceList();
  }, [desktop, session.cartesiaConfigured]);

  useEffect(() => {
    if (!desktop) {
      return;
    }
    const key = cartesiaKey.trim();
    if (key.length < 12) {
      return;
    }
    const handle = window.setTimeout(() => {
      void loadVoiceList(key);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [desktop, cartesiaKey]);

  async function loadGroqModels(key?: string) {
    if (!desktop) {
      return;
    }
    const token = key?.trim() ?? "";
    if (token && token.length < 12) {
      return;
    }
    if (!token && !session.groqConfigured) {
      return;
    }
    const cacheKey = token || "stored";
    if (fetchedGroq.current === cacheKey) {
      return;
    }
    fetchedGroq.current = cacheKey;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const catalog = await listGroqModels(token || undefined);
      setChatModels(catalog.chat);
      setSpeechModels(catalog.speech);
      setPreferences((current) => ({
        ...current,
        llmModel: preferModel(catalog.chat, current.llmModel, DEFAULT_CHAT_MODEL),
        sttModel: preferModel(catalog.speech, current.sttModel, DEFAULT_STT_MODEL),
      }));
      if (catalog.chat.length === 0 && catalog.speech.length === 0) {
        setModelsError("Groq returned no chat or speech models for this key.");
      }
    } catch (error: unknown) {
      fetchedGroq.current = "";
      setModelsError(toCommandError(error).message);
    } finally {
      setModelsLoading(false);
    }
  }

  async function loadVoiceList(key?: string) {
    if (!desktop) {
      return;
    }
    const token = key?.trim() ?? "";
    if (token && token.length < 12) {
      return;
    }
    if (!token && !session.cartesiaConfigured) {
      return;
    }
    const cacheKey = token || "stored";
    if (fetchedCartesia.current === cacheKey) {
      return;
    }
    fetchedCartesia.current = cacheKey;
    setVoicesLoading(true);
    setVoicesError(null);
    try {
      const next = await listVoices(token || undefined);
      setVoices(next);
    } catch (error: unknown) {
      fetchedCartesia.current = "";
      setVoicesError(toCommandError(error).message);
    } finally {
      setVoicesLoading(false);
    }
  }

  const chatChoices = withCurrent(
    chatModels.length > 0 || desktop ? chatModels : FALLBACK_CHAT_MODELS,
    preferences.llmModel,
  );
  const speechChoices = withCurrent(
    speechModels.length > 0 || desktop ? speechModels : FALLBACK_SPEECH_MODELS,
    preferences.sttModel,
  );
  const voiceChoices = voices.some((voice) => voice.id === preferences.voiceId)
    ? voices
    : [
        {
          id: preferences.voiceId,
          name: preferences.voiceId === DEFAULT_VOICE_ID ? "Skylar (default)" : "Saved voice",
          language: "en",
          description: "",
        },
        ...voices,
      ];

  async function onSave() {
    setSaving(true);
    setFormError(null);
    try {
      const next = await saveSettings({
        groqKey: groqKey.trim() || undefined,
        cartesiaKey: cartesiaKey.trim() || undefined,
        preferences,
      });
      onSession(next);
      setGroqKey("");
      setCartesiaKey("");
      onClose();
    } catch (error: unknown) {
      setFormError(toCommandError(error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onClear() {
    setSaving(true);
    setFormError(null);
    try {
      const next = await clearCredentials();
      onSession(next);
      setGroqKey("");
      setCartesiaKey("");
      setChatModels([]);
      setSpeechModels([]);
      fetchedGroq.current = "";
      fetchedCartesia.current = "";
    } catch (error: unknown) {
      setFormError(toCommandError(error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/70 px-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-line bg-card p-6 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="font-serif text-3xl">
              Settings
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Keys stay in the data folder next to Tolly. A Groq key loads the chat and speech models it can use. Cartesia speaks the reply.
            </p>
          </div>
          <button type="button" className="text-sm text-muted hover:text-ink" onClick={onClose}>
            Close
          </button>
        </div>

        {!desktop && (
          <p className="mt-4 rounded-xl bg-note px-3 py-2 text-sm">
            This window is the browser preview. Saving keys and detecting models runs in the desktop app.
          </p>
        )}

        <div className="mt-5 space-y-4">
          <KeyField
            label="Groq API key"
            configured={session.groqConfigured}
            value={groqKey}
            onChange={setGroqKey}
            onBlur={() => void loadGroqModels(groqKey)}
          />
          <KeyField
            label="Cartesia API key"
            configured={session.cartesiaConfigured}
            value={cartesiaKey}
            onChange={setCartesiaKey}
            onBlur={() => void loadVoiceList(cartesiaKey)}
          />
          <ModelSelect
            label="Conversation model"
            value={preferences.llmModel}
            models={chatChoices}
            loading={modelsLoading}
            empty="Enter a Groq key to load conversation models."
            onChange={(llmModel) => setPreferences((current) => ({ ...current, llmModel }))}
          />
          <ModelSelect
            label="Speech model"
            value={preferences.sttModel}
            models={speechChoices}
            loading={modelsLoading}
            empty="Enter a Groq key to load Whisper models."
            onChange={(sttModel) => setPreferences((current) => ({ ...current, sttModel }))}
          />
          {modelsError && <p className="text-sm text-danger">{modelsError}</p>}
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Cartesia voice</span>
            <select
              className="w-full rounded-xl border border-line bg-paper px-3 py-2"
              value={preferences.voiceId}
              onChange={(event) => setPreferences((current) => ({ ...current, voiceId: event.target.value }))}
            >
              {voiceChoices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name}
                  {voice.language ? ` · ${voice.language}` : ""}
                </option>
              ))}
            </select>
            {voicesLoading && <span className="mt-1 block text-muted">Loading voices…</span>}
            {voicesError && <span className="mt-1 block text-danger">{voicesError}</span>}
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Daily token budget</span>
            <input
              type="number"
              min={1000}
              max={2000000}
              className="w-full rounded-xl border border-line bg-paper px-3 py-2"
              value={preferences.dailyTokenBudget}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  dailyTokenBudget: Number(event.target.value),
                }))
              }
            />
          </label>
        </div>

        {formError && <p className="mt-4 text-sm text-danger">{formError}</p>}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <button type="button" className="text-sm text-danger disabled:opacity-50" disabled={saving || !desktop} onClick={() => void onClear()}>
            Remove keys
          </button>
          <button
            type="button"
            className="rounded-full bg-ink px-4 py-2 text-sm text-paper disabled:opacity-50"
            disabled={saving || !desktop}
            onClick={() => void onSave()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function withCurrent(models: ListedModel[], current: string): ListedModel[] {
  if (!current || models.some((model) => model.id === current)) {
    return models;
  }
  return [{ id: current, ownedBy: "", contextWindow: null }, ...models];
}

function ModelSelect({
  label,
  value,
  models,
  loading,
  empty,
  onChange,
}: {
  label: string;
  value: string;
  models: ListedModel[];
  loading: boolean;
  empty: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      {models.length === 0 ? (
        <p className="rounded-xl border border-line bg-paper px-3 py-2 text-muted">{loading ? "Checking Groq…" : empty}</p>
      ) : (
        <select
          className="w-full rounded-xl border border-line bg-paper px-3 py-2"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {modelLabel(model)}
            </option>
          ))}
        </select>
      )}
      {loading && models.length > 0 && <span className="mt-1 block text-muted">Checking Groq…</span>}
    </label>
  );
}

function KeyField({
  label,
  configured,
  value,
  onChange,
  onBlur,
}: {
  label: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  return (
    <label className="block text-sm" htmlFor={id}>
      <span className="mb-1 flex items-center justify-between text-muted">
        {label}
        <span>{configured ? "Saved" : "Not set"}</span>
      </span>
      <input
        id={id}
        type="password"
        autoComplete="off"
        className="w-full rounded-xl border border-line bg-paper px-3 py-2"
        placeholder={configured ? "Enter a new key to replace the saved one" : "Paste your key"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </label>
  );
}
