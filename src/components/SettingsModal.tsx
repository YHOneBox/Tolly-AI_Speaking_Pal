import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  clearCredentials,
  deleteCharacter,
  generateCharacter,
  listGroqModels,
  listVoices,
  previewVoice,
  saveSettings,
  setActiveCharacter,
  type UpdateOffer,
} from "../lib/api";
import {
  decodeBase64,
  listAudioDevices,
  PcmPlayer,
  SpeechCapture,
  supportsOutputSelection,
  type AudioDevices,
  type MicLevel,
} from "../lib/audio";
import { isDesktopShell, toCommandError } from "../lib/errors";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_STT_MODEL,
  DEFAULT_VOICE_ID,
  FALLBACK_CHAT_MODELS,
  FALLBACK_SPEECH_MODELS,
  modelLabel,
  normalizeFontSize,
  normalizeLayout,
  normalizeSensitivity,
  preferModel,
  type AppLayout,
  type Bootstrap,
  type Character,
  type ListedModel,
  type MicSensitivity,
  type Preferences,
  type VoiceOption,
} from "../types";
import { Face } from "./Avatar";
import { VoiceBar } from "./VoiceBar";

type SettingsModalProps = {
  session: Bootstrap;
  update: UpdateOffer | null;
  updateError: string | null;
  updating: boolean;
  updateReceived: number;
  updateTotal: number;
  onCheckUpdate: () => void;
  onApplyUpdate: () => void;
  onClose: () => void;
  onSession: (session: Bootstrap) => void;
  onAppearance: (appearance: { fontSize: number; layout: AppLayout }) => void;
};

type Tab = "keys" | "character" | "voice" | "mic" | "look" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "keys", label: "Keys" },
  { id: "character", label: "Character" },
  { id: "voice", label: "Voice" },
  { id: "mic", label: "Mic" },
  { id: "look", label: "Look" },
  { id: "about", label: "About" },
];

export function SettingsModal({
  session,
  update,
  updateError,
  updating,
  updateReceived,
  updateTotal,
  onCheckUpdate,
  onApplyUpdate,
  onClose,
  onSession,
  onAppearance,
}: SettingsModalProps) {
  const titleId = useId();
  const [tab, setTab] = useState<Tab>(session.groqConfigured && session.cartesiaConfigured ? "character" : "keys");
  const [groqKey, setGroqKey] = useState("");
  const [cartesiaKey, setCartesiaKey] = useState("");
  const [preferences, setPreferences] = useState<Preferences>(() => ({
    ...session.preferences,
    fontSize: normalizeFontSize(session.preferences.fontSize),
    layout: normalizeLayout(session.preferences.layout),
    micSensitivity: normalizeSensitivity(session.preferences.micSensitivity),
    inputDeviceId: session.preferences.inputDeviceId ?? "",
    outputDeviceId: session.preferences.outputDeviceId ?? "",
    autoListen: session.preferences.autoListen ?? true,
  }));
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [chatModels, setChatModels] = useState<ListedModel[]>([]);
  const [speechModels, setSpeechModels] = useState<ListedModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewPlayer = useRef<PcmPlayer | null>(null);
  const desktop = isDesktopShell();
  const fetchedGroq = useRef("");
  const fetchedCartesia = useRef("");

  useEffect(() => {
    return () => {
      previewPlayer.current?.stop();
    };
  }, []);

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

  function chooseLayout(layout: AppLayout): void {
    setPreferences((current) => ({ ...current, layout }));
    onAppearance({ fontSize: normalizeFontSize(preferences.fontSize), layout });
  }

  async function onPreview() {
    if (!desktop) {
      setFormError("Open the desktop app to hear this voice.");
      return;
    }
    setFormError(null);
    setPreviewing(true);
    const player = previewPlayer.current ?? new PcmPlayer();
    previewPlayer.current = player;
    player.setVolume(preferences.voiceVolume);
    player.setOutput(preferences.outputDeviceId);
    player.resume();
    player.stop();
    try {
      await previewVoice(
        preferences.voiceId,
        preferences.voiceSpeed,
        preferences.voiceVolume,
        "preview",
        (chunk) => {
          player.enqueue(decodeBase64(chunk.dataBase64), chunk.sampleRate);
        },
      );
      await player.waitUntilDone();
    } catch (error: unknown) {
      setFormError(toCommandError(error).message);
    } finally {
      setPreviewing(false);
    }
  }

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
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/70 px-4 py-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-line bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-5">
          <h2 id={titleId} className="text-xl font-semibold tracking-tight">
            Settings
          </h2>
          <button
            type="button"
            className="pill grid h-8 w-8 place-items-center rounded-full text-muted hover:text-ink"
            aria-label="Close settings"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="mx-6 mt-4 flex gap-1 rounded-2xl bg-paper p-1" role="tablist" aria-label="Settings sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={
                tab === item.id
                  ? "flex-1 rounded-xl bg-card-2 px-2 py-1.5 text-sm font-medium text-ink"
                  : "flex-1 rounded-xl px-2 py-1.5 text-sm text-muted hover:text-ink"
              }
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!desktop && (
            <p className="mb-4 rounded-xl bg-note px-3 py-2 text-sm text-muted">
              This window is the browser preview. Saving runs in the desktop app.
            </p>
          )}

          {tab === "keys" && (
            <Section
              title="API keys and models"
              intro="Keys stay encrypted in the data folder next to Tolly and are never shown again. A Groq key loads the models it can use."
            >
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
                label="Speech-to-text model"
                value={preferences.sttModel}
                models={speechChoices}
                loading={modelsLoading}
                empty="Enter a Groq key to load Whisper models."
                onChange={(sttModel) => setPreferences((current) => ({ ...current, sttModel }))}
              />
              {modelsError && <p className="text-sm text-danger">{modelsError}</p>}
            </Section>
          )}

          {tab === "character" && (
            <CharacterSection
              session={session}
              desktop={desktop}
              onSession={onSession}
            />
          )}

          {tab === "voice" && (
            <Section title="Voice" intro="Pick the voice Cartesia uses and how it sounds. Every character shares it. Preview plays through the speaker chosen in Mic.">
              <label className="block text-sm">
                <span className="mb-1 block text-muted">Voice</span>
                <select
                  className="field"
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
              <SliderField
                label="Speaking speed"
                min={0.6}
                max={1.5}
                step={0.05}
                value={preferences.voiceSpeed}
                suffix="×"
                onChange={(voiceSpeed) => setPreferences((current) => ({ ...current, voiceSpeed }))}
              />
              <SliderField
                label="Volume"
                min={0}
                max={100}
                step={1}
                digits={0}
                value={Math.round(preferences.voiceVolume * 100)}
                suffix="%"
                onChange={(percent) =>
                  setPreferences((current) => ({ ...current, voiceVolume: Math.min(1, Math.max(0, percent / 100)) }))
                }
              />
              <button
                type="button"
                className="pill rounded-full px-4 py-2 text-sm disabled:opacity-50"
                disabled={!desktop || previewing}
                onClick={() => void onPreview()}
              >
                {previewing ? "Playing…" : "Preview voice"}
              </button>
            </Section>
          )}

          {tab === "mic" && (
            <MicrophoneSection
              preferences={preferences}
              onChange={(patch) => setPreferences((current) => ({ ...current, ...patch }))}
            />
          )}

          {tab === "look" && (
            <Section title="Look" intro="Changes show behind this window right away. Save keeps them.">
              <SliderField
                label="Font size"
                min={11}
                max={20}
                step={1}
                digits={0}
                value={preferences.fontSize}
                suffix=" px"
                onChange={(fontSize) => {
                  const next = normalizeFontSize(fontSize);
                  setPreferences((current) => ({ ...current, fontSize: next }));
                  onAppearance({ fontSize: next, layout: preferences.layout });
                }}
              />
              <div>
                <p className="mb-2 text-sm text-muted">Layout</p>
                <Segmented
                  label="Layout"
                  value={preferences.layout}
                  options={[
                    { id: "center", label: "Centered" },
                    { id: "wide", label: "Wide" },
                    { id: "split", label: "Split" },
                  ]}
                  onChange={(layout) => chooseLayout(layout as AppLayout)}
                />
                <p className="mt-2 text-sm leading-6 text-muted">{layoutHint(preferences.layout)}</p>
              </div>
            </Section>
          )}

          {tab === "about" && (
            <Section title="About" intro={`This copy is Tolly ${session.version}.`}>
              <label className="block text-sm">
                <span className="mb-1 flex items-center justify-between text-muted">
                  Daily token budget
                  <span>{preferences.dailyTokenBudget.toLocaleString()} tokens</span>
                </span>
                <input
                  type="number"
                  min={1000}
                  max={2000000}
                  step={1000}
                  className="field"
                  value={preferences.dailyTokenBudget}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      dailyTokenBudget: Number(event.target.value),
                    }))
                  }
                />
                <span className="mt-1 block text-muted">Tolly stops calling Groq for the day once this is used up.</span>
              </label>
              <div className="rounded-2xl border border-line px-4 py-3">
                <p className="text-sm font-medium">Updates</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  {update
                    ? update.available
                      ? `Version ${update.latest} is on GitHub. This copy is ${update.current}.`
                      : `This copy is ${update.current}, the latest release.`
                    : "Tolly can download a newer portable build from GitHub and reopen itself."}
                </p>
                {updating && (
                  <p className="mt-1 text-sm text-muted">
                    Downloading
                    {updateTotal > 0 ? ` ${Math.min(100, Math.round((updateReceived / updateTotal) * 100))}%` : "…"}
                  </p>
                )}
                {updateError && <p className="mt-1 text-sm text-danger">{updateError}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="pill rounded-full px-3 py-1.5 text-sm disabled:opacity-50"
                    disabled={!desktop || updating}
                    onClick={onCheckUpdate}
                  >
                    Check for updates
                  </button>
                  {update?.available && (
                    <button
                      type="button"
                      className="btn-primary rounded-full px-3 py-1.5 text-sm"
                      disabled={!desktop || updating}
                      onClick={onApplyUpdate}
                    >
                      {updating ? "Installing…" : "Update and reopen"}
                    </button>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-danger/40 px-4 py-3">
                <p className="text-sm font-medium">Remove API keys</p>
                <p className="mt-1 text-sm leading-6 text-muted">Deletes both keys from this computer. Tolly cannot talk until new ones are added.</p>
                <button
                  type="button"
                  className="mt-3 rounded-full border border-danger/50 px-3 py-1.5 text-sm text-danger disabled:opacity-50"
                  disabled={saving || !desktop}
                  onClick={() => void onClear()}
                >
                  Remove keys
                </button>
              </div>
            </Section>
          )}
        </div>

        <div className="border-t border-line px-6 py-4">
          {formError && <p className="mb-3 text-sm text-danger">{formError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="rounded-full px-4 py-2 text-sm text-muted hover:text-ink" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary rounded-full px-5 py-2 text-sm font-medium"
              disabled={saving || !desktop}
              onClick={() => void onSave()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicrophoneSection({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}) {
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [], named: false });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [reading, setReading] = useState<MicLevel>({ level: 0, voiced: false, capturing: false });
  const [heard, setHeard] = useState(0);
  const capture = useRef<SpeechCapture | null>(null);
  const outputs = supportsOutputSelection();

  async function refresh(requestNames: boolean) {
    setDeviceError(null);
    try {
      setDevices(await listAudioDevices(requestNames));
    } catch (error: unknown) {
      setDeviceError(error instanceof Error ? error.message : "The device list could not be read.");
    }
  }

  useEffect(() => {
    void refresh(false);
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) {
      return;
    }
    const onChangeDevices = () => void refresh(false);
    media.addEventListener("devicechange", onChangeDevices);
    return () => media.removeEventListener("devicechange", onChangeDevices);
  }, []);

  useEffect(() => {
    return () => {
      void capture.current?.stop();
      capture.current = null;
    };
  }, []);

  // Restart the test when the microphone or sensitivity changes, so what you hear is what you saved.
  useEffect(() => {
    if (!testing) {
      return;
    }
    let cancelled = false;
    void (async () => {
      await capture.current?.stop();
      capture.current = null;
      if (cancelled) {
        return;
      }
      const next = new SpeechCapture(
        () => setHeard((count) => count + 1),
        () => undefined,
        (level) => setReading(level),
        { deviceId: preferences.inputDeviceId, sensitivity: preferences.micSensitivity },
      );
      try {
        await next.start();
        if (cancelled) {
          await next.stop();
          return;
        }
        capture.current = next;
        void refresh(false);
      } catch (error: unknown) {
        const name = error instanceof DOMException ? error.name : "";
        setDeviceError(name === "NotAllowedError" ? "Microphone permission was blocked." : "That microphone could not be opened.");
        setTesting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [testing, preferences.inputDeviceId, preferences.micSensitivity]);

  async function toggleTest() {
    if (testing) {
      setTesting(false);
      await capture.current?.stop();
      capture.current = null;
      setReading({ level: 0, voiced: false, capturing: false });
      return;
    }
    setHeard(0);
    setTesting(true);
  }

  const inputMissing = preferences.inputDeviceId !== "" && !devices.inputs.some((device) => device.id === preferences.inputDeviceId);
  const outputMissing = preferences.outputDeviceId !== "" && !devices.outputs.some((device) => device.id === preferences.outputDeviceId);

  return (
    <Section
      title="Microphone and speaker"
      intro="Choose which devices Tolly uses and how easily it notices your voice. Tap the microphone button once in the main window, and Tolly listens on its own; hold it if you prefer to control each sentence."
    >
      <label className="block text-sm">
        <span className="mb-1 flex items-center justify-between text-muted">
          Microphone
          <button type="button" className="text-xs text-accent-dark hover:underline" onClick={() => void refresh(true)}>
            {devices.named ? "Refresh list" : "Show device names"}
          </button>
        </span>
        <select
          className="field"
          value={inputMissing ? "" : preferences.inputDeviceId}
          onChange={(event) => onChange({ inputDeviceId: event.target.value })}
        >
          <option value="">System default microphone</option>
          {devices.inputs.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
        {inputMissing && <span className="mt-1 block text-muted">The saved microphone is not connected. The system default is used until it returns.</span>}
      </label>

      {outputs && (
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Speaker</span>
          <select
            className="field"
            value={outputMissing ? "" : preferences.outputDeviceId}
            onChange={(event) => onChange({ outputDeviceId: event.target.value })}
          >
            <option value="">System default speaker</option>
            {devices.outputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
          {outputMissing && <span className="mt-1 block text-muted">The saved speaker is not connected. The system default is used until it returns.</span>}
        </label>
      )}

      <label className="flex items-start justify-between gap-4 rounded-2xl border border-line px-4 py-3">
        <span>
          <span className="block text-sm font-medium">Start listening when Tolly opens</span>
          <span className="mt-1 block text-sm leading-6 text-muted">
            With both keys saved, the microphone opens on its own and you can just start talking.
          </span>
        </span>
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0 accent-[#6d5dfc]"
          checked={preferences.autoListen}
          onChange={(event) => onChange({ autoListen: event.target.checked })}
        />
      </label>

      <div>
        <p className="mb-2 text-sm text-muted">Sensitivity</p>
        <Segmented
          label="Microphone sensitivity"
          value={preferences.micSensitivity}
          options={[
            { id: "low", label: "Low" },
            { id: "normal", label: "Normal" },
            { id: "high", label: "High" },
          ]}
          onChange={(micSensitivity) => onChange({ micSensitivity: micSensitivity as MicSensitivity })}
        />
        <p className="mt-2 text-sm leading-6 text-muted">{sensitivityHint(preferences.micSensitivity)}</p>
      </div>

      <div className="rounded-2xl border border-line px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Test the microphone</p>
            <p className="text-sm text-muted">Say a sentence and watch the bar turn purple. Pause, and Tolly counts it as heard.</p>
          </div>
          <button
            type="button"
            className={`${testing ? "btn-primary" : "pill"} shrink-0 rounded-full px-3 py-1.5 text-sm`}
            onClick={() => void toggleTest()}
          >
            {testing ? "Stop" : "Start"}
          </button>
        </div>
        <div className="mt-3">
          <VoiceBar reading={reading} open={testing} />
        </div>
        {testing && (
          <p className="mt-2 text-center text-sm text-muted" aria-live="polite">
            {heard === 0 ? "Nothing heard yet." : heard === 1 ? "Heard 1 sentence." : `Heard ${heard} sentences.`}
          </p>
        )}
      </div>
      {deviceError && <p className="text-sm text-danger">{deviceError}</p>}
    </Section>
  );
}

function CharacterSection({
  session,
  desktop,
  onSession,
}: {
  session: Bootstrap;
  desktop: boolean;
  onSession: (session: Bootstrap) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(session.activeCharacterId || null);
  const canGenerate = desktop && session.groqConfigured && prompt.trim().length >= 3 && busy === null;

  async function act(label: string, work: () => Promise<Bootstrap>) {
    setBusy(label);
    setError(null);
    try {
      onSession(await work());
      return true;
    } catch (failure: unknown) {
      setError(toCommandError(failure).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function onGenerate() {
    if (!desktop) {
      setError("Open the desktop app to create a character.");
      return;
    }
    const text = prompt.trim();
    const ok = await act("generate", () => generateCharacter(text));
    if (ok) {
      setPrompt("");
    }
  }

  const ideas = ["a chef from Lisbon who loves football", "a retired sailor with a dog", "a cheerful barista in Tokyo"];

  return (
    <Section
      title="Who you talk to"
      intro="Describe a person in a few words and Tolly writes a full character: a name, a short profile, and a way of talking. Pick anyone here to start a fresh conversation with them."
    >
      <div className="rounded-2xl border border-line px-4 py-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Create a character</span>
          <textarea
            className="field min-h-20 resize-y"
            placeholder="For example: a chef from Lisbon who loves football"
            value={prompt}
            maxLength={600}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {ideas.map((idea) => (
            <button key={idea} type="button" className="pill rounded-full px-3 py-1 text-xs text-muted hover:text-ink" onClick={() => setPrompt(idea)}>
              {idea}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {session.groqConfigured ? "Uses your Groq key once." : "Add a Groq key in Keys first."}
          </p>
          <button type="button" className="btn-primary rounded-full px-4 py-1.5 text-sm" disabled={!canGenerate} onClick={() => void onGenerate()}>
            {busy === "generate" ? "Writing…" : "Generate"}
          </button>
        </div>
      </div>

      <ul className="space-y-2" aria-label="Characters">
        <CharacterCard
          name="Tolly"
          tagline="The built-in friend who talks about anything"
          emoji={null}
          active={session.activeCharacterId === ""}
          busy={busy !== null}
          expanded={open === "tolly"}
          onToggle={() => setOpen(open === "tolly" ? null : "tolly")}
          onUse={() => void act("use", () => setActiveCharacter(""))}
        >
          <p className="text-sm leading-6 text-muted">
            A friend sitting with you and talking. No lessons, no quizzes, just conversation. Tolly is always here and cannot be removed.
          </p>
        </CharacterCard>
        {session.characters.map((character) => (
          <CharacterCard
            key={character.id}
            name={character.name}
            tagline={character.tagline}
            emoji={character.emoji}
            active={session.activeCharacterId === character.id}
            busy={busy !== null}
            expanded={open === character.id}
            onToggle={() => setOpen(open === character.id ? null : character.id)}
            onUse={() => void act("use", () => setActiveCharacter(character.id))}
            onRemove={() => void act("remove", () => deleteCharacter(character.id))}
          >
            <CharacterDetails character={character} />
          </CharacterCard>
        ))}
      </ul>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Section>
  );
}

function CharacterCard({
  name,
  tagline,
  emoji,
  active,
  busy,
  expanded,
  onToggle,
  onUse,
  onRemove,
  children,
}: {
  name: string;
  tagline: string;
  emoji: string | null;
  active: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onUse: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <li className={`rounded-2xl border px-4 py-3 ${active ? "border-accent/60 bg-note" : "border-line"}`}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-card-2 text-xl" aria-hidden="true">
          {emoji ?? <Face phase="idle" small />}
        </span>
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={expanded} onClick={onToggle}>
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            {active && <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-accent">Talking now</span>}
          </span>
          <span className="block truncate text-sm text-muted">{tagline}</span>
        </button>
        {!active && (
          <button type="button" className="btn-primary shrink-0 rounded-full px-3 py-1.5 text-sm" disabled={busy} onClick={onUse}>
            Talk
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          {children}
          {onRemove && (
            <button type="button" className="text-sm text-danger hover:underline disabled:opacity-50" disabled={busy} onClick={onRemove}>
              Remove this character
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function CharacterDetails({ character }: { character: Character }) {
  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted">About</dt>
        <dd className="mt-0.5 leading-6">{character.description}</dd>
      </div>
      {character.personality && (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Personality</dt>
          <dd className="mt-0.5 leading-6">{character.personality}</dd>
        </div>
      )}
      {character.speakingStyle && (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">How they talk</dt>
          <dd className="mt-0.5 leading-6">{character.speakingStyle}</dd>
        </div>
      )}
      {character.greeting && (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Opening line</dt>
          <dd className="mt-0.5 leading-6 italic">“{character.greeting}”</dd>
        </div>
      )}
      {character.prompt && (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Made from</dt>
          <dd className="mt-0.5 leading-6 text-muted">{character.prompt}</dd>
        </div>
      )}
    </dl>
  );
}

function sensitivityHint(value: MicSensitivity): string {
  if (value === "low") {
    return "For noisy rooms or a microphone that picks up everything. You need to speak a little more clearly.";
  }
  if (value === "high") {
    return "For quiet voices or a microphone that is far away. Room noise is more likely to start a turn.";
  }
  return "A good fit for most laptops and headsets.";
}

function layoutHint(layout: AppLayout): string {
  if (layout === "wide") {
    return "The conversation and grammar card use the width of the window.";
  }
  if (layout === "split") {
    return "The conversation sits on the left. The grammar card sits on the right.";
  }
  return "Everything stays in a column in the middle.";
}

function Section({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-muted">{intro}</p>
      </div>
      {children}
    </section>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          className={
            value === option.id
              ? "btn-primary rounded-xl px-2 py-2 text-sm"
              : "rounded-xl border border-line px-2 py-2 text-sm text-muted hover:text-ink"
          }
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SliderField({
  label,
  min,
  max,
  step,
  value,
  suffix,
  digits = 2,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  suffix: string;
  digits?: number;
  onChange: (value: number) => void;
}) {
  const shown = Number.isFinite(value) ? value : 1;
  return (
    <label className="block text-sm">
      <span className="mb-1 flex items-center justify-between text-muted">
        {label}
        <span className="text-ink">
          {shown.toFixed(digits)}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        className="w-full accent-[#6d5dfc]"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
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
        <p className="field text-muted">{loading ? "Checking Groq…" : empty}</p>
      ) : (
        <select className="field" value={value} onChange={(event) => onChange(event.target.value)}>
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
        <span className={configured ? "text-success" : ""}>{configured ? "Saved" : "Not set"}</span>
      </span>
      <input
        id={id}
        type="password"
        autoComplete="off"
        className="field"
        placeholder={configured ? "Enter a new key to replace the saved one" : "Paste your key"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </label>
  );
}
