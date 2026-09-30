import { useEffect, useRef, useState } from "react";

import { ChatTranscript } from "./components/ChatTranscript";
import { Composer } from "./components/Composer";
import { RateLimitBanner } from "./components/RateLimitBanner";
import { SettingsModal } from "./components/SettingsModal";
import { bootstrap, cancelSpeech, converse, saveSettings, speak, transcribe } from "./lib/api";
import { decodeBase64, PcmPlayer, SpeechCapture } from "./lib/audio";
import { isDesktopShell, toCommandError } from "./lib/errors";
import { blendSkill, estimateSkill, parseDualOutput, speakingBand } from "./lib/parseReply";
import {
  DEFAULT_PREFERENCES,
  normalizeCaptureMode,
  usageTotal,
  type Bootstrap,
  type CaptureMode,
  type ChatMessage,
  type CommandError,
  type Phase,
} from "./types";

const EMPTY_SESSION: Bootstrap = {
  groqConfigured: false,
  cartesiaConfigured: false,
  preferences: DEFAULT_PREFERENCES,
  usage: { day: "", promptTokens: 0, completionTokens: 0 },
  warningRatio: 0.8,
};

export default function App() {
  const desktop = isDesktopShell();
  const [session, setSession] = useState<Bootstrap>(EMPTY_SESSION);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [skillRating, setSkillRating] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<CommandError | null>(null);
  const [budgetNote, setBudgetNote] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("vad");

  const messagesRef = useRef(messages);
  const sessionRef = useRef(session);
  const listeningRef = useRef(false);
  const holdingRef = useRef(false);
  const holdWantedRef = useRef(false);
  const lockRef = useRef(false);
  const turnGen = useRef(0);
  const captureRef = useRef<SpeechCapture | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const onUtteranceRef = useRef<(wav: Uint8Array) => void>(() => undefined);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!desktop) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await bootstrap();
        if (!cancelled) {
          setSession(next);
          setCaptureMode(normalizeCaptureMode(next.preferences.captureMode));
          if (usageTotal(next.usage) / next.preferences.dailyTokenBudget >= next.warningRatio) {
            setBudgetNote("You have used most of today's token budget.");
          }
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setNotice(toCommandError(error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => {
    return () => {
      void captureRef.current?.stop();
      playerRef.current?.stop();
    };
  }, []);

  function player(): PcmPlayer {
    if (!playerRef.current) {
      playerRef.current = new PcmPlayer();
    }
    return playerRef.current;
  }

  function showFailure(error: unknown): void {
    const command = toCommandError(error);
    if (command.code === "rate_limited") {
      setRateLimit(command);
      setNotice(null);
      return;
    }
    if (command.code === "budget_exceeded") {
      setBudgetNote(command.message);
    }
    setNotice(command.message);
  }

  function finishListeningState(generation: number): void {
    if (generation !== turnGen.current) {
      return;
    }
    lockRef.current = false;
    if (listeningRef.current) {
      captureRef.current?.setPaused(false);
      setPhase("listening");
      return;
    }
    setPhase("idle");
  }

  async function runTurn(userText: string, generation: number, shown = true): Promise<void> {
    const history = [
      ...messagesRef.current.map((message) => ({ role: message.role, content: message.text })),
      { role: "user" as const, content: userText },
    ];
    if (shown) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: userText }]);
    }
    setPhase("thinking");
    setNotice(null);
    const result = await converse(history);
    if (generation !== turnGen.current) {
      return;
    }
    const parsed = parseDualOutput(result.rawJson);
    if (shown) {
      const next = parsed.skillRating ?? estimateSkill(parsed.visualFeedback.length);
      setSkillRating((current) => blendSkill(current, next));
    }
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: parsed.spokenReply,
        feedback: parsed.visualFeedback,
      },
    ]);
    setSession((current) => ({
      ...current,
      usage: {
        ...current.usage,
        promptTokens: current.usage.promptTokens + result.promptTokens,
        completionTokens: current.usage.completionTokens + result.completionTokens,
      },
    }));
    setBudgetNote(result.budgetWarning ? "You have used most of today's token budget." : null);
    setRateLimit(null);

    const turnId = crypto.randomUUID();
    const playback = player();
    playback.resume();
    playback.stop();
    setPhase("speaking");
    await speak(parsed.spokenReply, turnId, (chunk) => {
      if (generation !== turnGen.current) {
        return;
      }
      playback.enqueue(decodeBase64(chunk.dataBase64), chunk.sampleRate);
    });
    if (generation !== turnGen.current) {
      return;
    }
    await playback.waitUntilDone();
  }

  onUtteranceRef.current = (wav) => {
    if (lockRef.current || (!listeningRef.current && !holdingRef.current)) {
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    captureRef.current?.setPaused(true);
    void (async () => {
      try {
        setPhase("transcribing");
        const text = (await transcribe(wav)).trim();
        if (generation !== turnGen.current) {
          return;
        }
        if (!text) {
          setNotice("I couldn't hear any words. Try again.");
          return;
        }
        await runTurn(text, generation);
      } catch (error: unknown) {
        if (generation === turnGen.current) {
          showFailure(error);
        }
      } finally {
        finishListeningState(generation);
      }
    })();
  };

  async function releaseMic(): Promise<void> {
    listeningRef.current = false;
    holdingRef.current = false;
    holdWantedRef.current = false;
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop();
    if (!lockRef.current) {
      setPhase("idle");
    }
  }

  async function chooseCaptureMode(mode: CaptureMode): Promise<void> {
    if (mode === captureMode) {
      return;
    }
    await releaseMic();
    const preferences = { ...sessionRef.current.preferences, captureMode: mode };
    setCaptureMode(mode);
    setSession((current) => ({ ...current, preferences }));
    if (!desktop) {
      return;
    }
    try {
      const next = await saveSettings({ preferences });
      setSession(next);
      setCaptureMode(normalizeCaptureMode(next.preferences.captureMode));
    } catch (error: unknown) {
      setNotice(toCommandError(error).message);
    }
  }

  async function holdStart(): Promise<void> {
    setNotice(null);
    if (lockRef.current || holdingRef.current) {
      return;
    }
    if (!desktop) {
      setNotice("Open the desktop app to capture speech and call the APIs.");
      return;
    }
    if (!sessionRef.current.groqConfigured || !sessionRef.current.cartesiaConfigured) {
      setSettingsOpen(true);
      setNotice("Add both API keys in Settings first.");
      return;
    }

    holdWantedRef.current = true;
    holdingRef.current = true;
    setPhase("listening");
    try {
      player().resume();
      const capture = new SpeechCapture((wav) => onUtteranceRef.current(wav));
      capture.setMode("hold");
      captureRef.current = capture;
      await capture.start();
      if (!holdWantedRef.current) {
        await capture.stop();
        if (captureRef.current === capture) {
          captureRef.current = null;
        }
        holdingRef.current = false;
        setPhase("idle");
        setNotice("Hold the button until you finish the sentence.");
        return;
      }
      capture.beginHold();
    } catch (error: unknown) {
      holdingRef.current = false;
      holdWantedRef.current = false;
      captureRef.current = null;
      const name = error instanceof DOMException ? error.name : "";
      setNotice(name === "NotAllowedError" ? "Microphone permission was blocked." : toCommandError(error).message);
      setPhase("idle");
    }
  }

  async function holdEnd(): Promise<void> {
    if (!holdingRef.current && !holdWantedRef.current) {
      return;
    }
    holdWantedRef.current = false;
    const capture = captureRef.current;
    const emitted = capture?.endHold() ?? false;
    holdingRef.current = false;
    listeningRef.current = false;
    captureRef.current = null;
    await capture?.stop();
    if (!emitted && !lockRef.current) {
      setPhase("idle");
    }
  }

  async function toggleMic(): Promise<void> {
    setNotice(null);
    if (!desktop) {
      setNotice("Open the desktop app to capture speech and call the APIs.");
      return;
    }
    if (listeningRef.current || lockRef.current) {
      turnGen.current += 1;
      listeningRef.current = false;
      lockRef.current = false;
      await cancelSpeech();
      player().stop();
      await captureRef.current?.stop();
      captureRef.current = null;
      setPhase("idle");
      return;
    }

    if (!session.groqConfigured || !session.cartesiaConfigured) {
      setSettingsOpen(true);
      setNotice("Add both API keys in Settings first.");
      return;
    }

    try {
      player().resume();
      const capture = new SpeechCapture((wav) => onUtteranceRef.current(wav));
      capture.setMode("vad");
      await capture.start();
      captureRef.current = capture;
      listeningRef.current = true;
      setPhase("listening");
    } catch (error: unknown) {
      const name = error instanceof DOMException ? error.name : "";
      setNotice(
        name === "NotAllowedError"
          ? "Microphone permission was blocked."
          : toCommandError(error).message,
      );
      setPhase("idle");
    }
  }

  async function startTalking(): Promise<void> {
    if (lockRef.current || messagesRef.current.length > 0) {
      return;
    }
    if (!desktop) {
      setNotice("Open the desktop app to start the conversation.");
      return;
    }
    if (!session.groqConfigured || !session.cartesiaConfigured) {
      setSettingsOpen(true);
      setNotice("Add both API keys in Settings first.");
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    captureRef.current?.setPaused(true);
    try {
      player().resume();
      await runTurn("(just sat down)", generation, false);
    } catch (error: unknown) {
      if (generation === turnGen.current) {
        showFailure(error);
      }
    } finally {
      finishListeningState(generation);
    }
  }

  async function submitDraft(): Promise<void> {
    const text = draft.trim();
    if (!text || lockRef.current) {
      return;
    }
    if (!desktop) {
      setNotice("Open the desktop app to send this to Groq and Cartesia.");
      return;
    }
    if (!session.groqConfigured || !session.cartesiaConfigured) {
      setSettingsOpen(true);
      setNotice("Add both API keys in Settings first.");
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    captureRef.current?.setPaused(true);
    setDraft("");
    try {
      player().resume();
      await runTurn(text, generation);
    } catch (error: unknown) {
      if (generation === turnGen.current) {
        showFailure(error);
      }
    } finally {
      finishListeningState(generation);
    }
  }

  const total = usageTotal(session.usage);
  const budget = session.preferences.dailyTokenBudget;
  const keysReady = session.groqConfigured && session.cartesiaConfigured;

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <header className="border-b border-line px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div>
            <p className="font-serif text-2xl leading-none">Tolly</p>
            <p className="mt-1 text-sm text-muted">Talk about whatever comes up.</p>
          </div>
          <div className="flex items-center gap-4">
            <div
              className="min-w-16 text-right"
              aria-label={
                skillRating === null
                  ? "Speaking skill for this conversation is not rated yet"
                  : `Speaking skill for this conversation, ${skillRating}, ${speakingBand(skillRating)}`
              }
            >
              <p className="text-[0.65rem] uppercase tracking-[0.16em] text-muted">Speaking</p>
              <p className="font-serif text-3xl leading-none">{skillRating ?? "—"}</p>
              <p className="text-xs text-muted">{skillRating === null ? "Not yet" : speakingBand(skillRating)}</p>
            </div>
            <p className={budgetNote ? "text-sm text-accent" : "text-sm text-muted"}>
              {total.toLocaleString()} / {budget.toLocaleString()} tokens today
            </p>
            <button
              type="button"
              className="rounded-full border border-line bg-card px-3 py-1.5 text-sm"
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </button>
          </div>
        </div>
        {budgetNote && <p className="mx-auto mt-2 max-w-3xl text-sm text-accent">{budgetNote}</p>}
        {!desktop && (
          <p className="mx-auto mt-2 max-w-3xl text-sm text-muted">
            Browser preview. Key storage, Groq, and Cartesia run inside the portable desktop app.
          </p>
        )}
      </header>
      {rateLimit && <RateLimitBanner error={rateLimit} onDismiss={() => setRateLimit(null)} />}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ChatTranscript
          messages={messages}
          keysReady={keysReady}
          captureMode={captureMode}
          onOpenSettings={() => setSettingsOpen(true)}
          onStartTalking={() => void startTalking()}
        />
      </main>
      <Composer
        draft={draft}
        phase={phase}
        notice={notice}
        captureMode={captureMode}
        onDraftChange={setDraft}
        onSubmit={() => void submitDraft()}
        onToggleMic={() => void toggleMic()}
        onCaptureMode={(mode) => void chooseCaptureMode(mode)}
        onHoldStart={() => void holdStart()}
        onHoldEnd={() => void holdEnd()}
      />
      {settingsOpen && (
        <SettingsModal session={session} onClose={() => setSettingsOpen(false)} onSession={setSession} />
      )}
    </div>
  );
}
