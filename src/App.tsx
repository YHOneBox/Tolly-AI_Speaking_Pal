import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { Presence, TalkButton } from "./components/Composer";
import { RateLimitBanner } from "./components/RateLimitBanner";
import { SettingsModal } from "./components/SettingsModal";
import { Stage } from "./components/Stage";
import {
  applyUpdate,
  bootstrap,
  cancelSpeech,
  checkUpdate,
  converse,
  speak,
  transcribe,
  type UpdateOffer,
  type UpdateProgress,
} from "./lib/api";
import { decodeBase64, PcmPlayer, SpeechCapture } from "./lib/audio";
import { isDesktopShell, toCommandError } from "./lib/errors";
import { blendSkill, estimateSkill, parseDualOutput, speakingBand } from "./lib/parseReply";
import {
  DEFAULT_PREFERENCES,
  normalizeFontSize,
  normalizeLayout,
  usageTotal,
  type AppLayout,
  type Bootstrap,
  type ChatMessage,
  type CommandError,
  type Phase,
} from "./types";

const EMPTY_SESSION: Bootstrap = {
  version: "1.0.1",
  groqConfigured: false,
  cartesiaConfigured: false,
  preferences: DEFAULT_PREFERENCES,
  usage: { day: "", promptTokens: 0, completionTokens: 0 },
  warningRatio: 0.8,
};

export default function App() {
  const desktop = isDesktopShell();
  const [session, setSession] = useState<Bootstrap>(EMPTY_SESSION);
  const [skillRating, setSkillRating] = useState<number | null>(null);
  const [youSaid, setYouSaid] = useState<string | null>(null);
  const [latestNotes, setLatestNotes] = useState<string[]>([]);
  const [earlierNotes, setEarlierNotes] = useState<string[]>([]);
  const [tollySaid, setTollySaid] = useState<string | null>(null);
  const [heardYou, setHeardYou] = useState(false);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [micOpen, setMicOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<CommandError | null>(null);
  const [budgetNote, setBudgetNote] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearanceDraft, setAppearanceDraft] = useState<{ fontSize: number; layout: AppLayout } | null>(null);
  const [update, setUpdate] = useState<UpdateOffer | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateReceived, setUpdateReceived] = useState(0);
  const [updateTotal, setUpdateTotal] = useState(0);

  const sessionRef = useRef(session);
  const messagesRef = useRef<ChatMessage[]>([]);
  const latestNotesRef = useRef<string[]>([]);
  const listeningRef = useRef(false);
  const holdingRef = useRef(false);
  const holdWantedRef = useRef(false);
  const lockRef = useRef(false);
  const turnGen = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const captureRef = useRef<SpeechCapture | null>(null);
  const openingMic = useRef<Promise<SpeechCapture> | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const bargeTimer = useRef<number | null>(null);
  const onUtteranceRef = useRef<(wav: Uint8Array) => void>(() => undefined);
  const onSpeechStartRef = useRef<() => void>(() => undefined);

  function setPhase(next: Phase): void {
    phaseRef.current = next;
    setPhaseState(next);
  }

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const fontSize = normalizeFontSize(appearanceDraft?.fontSize ?? session.preferences.fontSize);
  const layout = normalizeLayout(appearanceDraft?.layout ?? session.preferences.layout);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  useEffect(() => {
    if (!desktop) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await bootstrap();
        if (cancelled) {
          return;
        }
        setSession(next);
        if (usageTotal(next.usage) / next.preferences.dailyTokenBudget >= next.warningRatio) {
          setBudgetNote("You have used most of today's token budget.");
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setNotice(toCommandError(error).message);
        }
      }
      try {
        const offer = await checkUpdate();
        if (!cancelled) {
          setUpdate(offer);
        }
      } catch {
        // A failed check stays quiet until Settings asks again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !updating) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let closed = false;
    void listen<UpdateProgress>("update-progress", (event) => {
      setUpdateReceived(event.payload.received);
      setUpdateTotal(event.payload.total);
    }).then((stop) => {
      if (closed) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [desktop, updating]);

  useEffect(() => {
    return () => {
      void captureRef.current?.stop();
      playerRef.current?.stop();
      if (bargeTimer.current !== null) {
        window.clearTimeout(bargeTimer.current);
      }
    };
  }, []);

  function player(): PcmPlayer {
    if (!playerRef.current) {
      playerRef.current = new PcmPlayer();
    }
    return playerRef.current;
  }

  function clearBargeTimer(): void {
    if (bargeTimer.current !== null) {
      window.clearTimeout(bargeTimer.current);
      bargeTimer.current = null;
    }
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

  function keysReady(): boolean {
    return sessionRef.current.groqConfigured && sessionRef.current.cartesiaConfigured;
  }

  function requireReady(): boolean {
    if (!desktop) {
      setNotice("Open the desktop app to capture speech and call the APIs.");
      return false;
    }
    if (!keysReady()) {
      setSettingsOpen(true);
      setNotice("Add both API keys in Settings first.");
      return false;
    }
    return true;
  }

  function cutAssistant(): void {
    turnGen.current += 1;
    lockRef.current = false;
    clearBargeTimer();
    captureRef.current?.setBargeIn(false);
    void cancelSpeech();
    player().stop();
  }

  function remember(message: ChatMessage): void {
    messagesRef.current = [...messagesRef.current, message].slice(-8);
  }

  async function ensureCapture(): Promise<SpeechCapture> {
    if (captureRef.current) {
      return captureRef.current;
    }
    if (openingMic.current) {
      return openingMic.current;
    }
    const pending = (async () => {
      const capture = new SpeechCapture(
        (wav) => onUtteranceRef.current(wav),
        () => onSpeechStartRef.current(),
      );
      await capture.start();
      captureRef.current = capture;
      return capture;
    })();
    openingMic.current = pending;
    try {
      return await pending;
    } finally {
      openingMic.current = null;
    }
  }

  async function armBarge(generation: number): Promise<void> {
    try {
      const capture = await ensureCapture();
      if (generation !== turnGen.current) {
        return;
      }
      capture.setPaused(false);
      clearBargeTimer();
      bargeTimer.current = window.setTimeout(() => {
        if (generation === turnGen.current) {
          captureRef.current?.setBargeIn(true);
        }
      }, 700);
    } catch {
      // The reply still plays. The button can cut in if the microphone is unavailable.
    }
  }

  function finishListeningState(generation: number): void {
    if (generation !== turnGen.current) {
      return;
    }
    lockRef.current = false;
    clearBargeTimer();
    captureRef.current?.setBargeIn(false);
    if (listeningRef.current) {
      captureRef.current?.setPaused(false);
      setPhase("listening");
      return;
    }
    const capture = captureRef.current;
    captureRef.current = null;
    void capture?.stop();
    if (!holdingRef.current) {
      setPhase("idle");
    }
  }

  async function runTurn(userText: string, generation: number, shown = true): Promise<void> {
    const history = [
      ...messagesRef.current.map((message) => ({
        role: message.role,
        content:
          message.role === "assistant"
            ? JSON.stringify({
                spoken_reply: message.text,
                visual_feedback: [],
                skill_rating: message.skillRating ?? null,
              })
            : message.text,
      })),
      { role: "user" as const, content: userText },
    ];
    if (shown) {
      remember({ id: crypto.randomUUID(), role: "user", text: userText });
    }
    captureRef.current?.setBargeIn(false);
    captureRef.current?.setPaused(true);
    clearBargeTimer();
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
      setEarlierNotes((current) => [...latestNotesRef.current, ...current].filter((note) => note.length > 0).slice(0, 6));
      latestNotesRef.current = parsed.visualFeedback;
      setLatestNotes(parsed.visualFeedback);
      setYouSaid(userText);
      setHeardYou(true);
    }
    setTollySaid(parsed.spokenReply);
    remember({
      id: crypto.randomUUID(),
      role: "assistant",
      text: parsed.spokenReply,
      feedback: parsed.visualFeedback,
      skillRating: parsed.skillRating,
    });
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
    playback.setVolume(session.preferences.voiceVolume);
    playback.resume();
    playback.stop();
    setPhase("speaking");
    await armBarge(generation);
    if (generation !== turnGen.current) {
      return;
    }
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
    if (generation !== turnGen.current) {
      return;
    }
    clearBargeTimer();
    captureRef.current?.setBargeIn(false);
  }

  onSpeechStartRef.current = () => {
    if (phaseRef.current !== "speaking") {
      return;
    }
    cutAssistant();
    setPhase("listening");
  };

  onUtteranceRef.current = (wav) => {
    if (lockRef.current) {
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    captureRef.current?.setPaused(true);
    captureRef.current?.setBargeIn(false);
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
    setMicOpen(false);
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop();
    if (!lockRef.current) {
      setPhase("idle");
    }
  }

  async function startContinuous(): Promise<void> {
    if (!requireReady()) {
      return;
    }
    try {
      player().resume();
      const capture = await ensureCapture();
      capture.setPaused(false);
      listeningRef.current = true;
      setMicOpen(true);
      setPhase("listening");
    } catch (error: unknown) {
      const name = error instanceof DOMException ? error.name : "";
      setNotice(name === "NotAllowedError" ? "Microphone permission was blocked." : toCommandError(error).message);
      setPhase("idle");
    }
  }

  async function onShortPress(): Promise<void> {
    setNotice(null);
    const busy = phaseRef.current === "speaking" || phaseRef.current === "thinking" || phaseRef.current === "transcribing";
    if (busy) {
      cutAssistant();
    }
    if (listeningRef.current && !busy) {
      await releaseMic();
      return;
    }
    if (!listeningRef.current) {
      await startContinuous();
      return;
    }
    setPhase("listening");
  }

  async function holdStart(): Promise<void> {
    setNotice(null);
    if (holdingRef.current) {
      return;
    }
    const busy = phaseRef.current === "speaking" || phaseRef.current === "thinking" || phaseRef.current === "transcribing";
    if (busy) {
      cutAssistant();
    }
    if (!requireReady()) {
      return;
    }
    holdWantedRef.current = true;
    holdingRef.current = true;
    setPhase("listening");
    try {
      player().resume();
      const capture = await ensureCapture();
      if (!holdWantedRef.current) {
        holdingRef.current = false;
        if (!listeningRef.current) {
          captureRef.current = null;
          await capture.stop();
          setPhase("idle");
        }
        setNotice("Hold the button until you finish the sentence.");
        return;
      }
      capture.beginHold();
    } catch (error: unknown) {
      holdingRef.current = false;
      holdWantedRef.current = false;
      const name = error instanceof DOMException ? error.name : "";
      setNotice(name === "NotAllowedError" ? "Microphone permission was blocked." : toCommandError(error).message);
      setPhase(listeningRef.current ? "listening" : "idle");
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
    if (!listeningRef.current && capture) {
      captureRef.current = null;
      await capture.stop();
    }
    if (!emitted && !lockRef.current) {
      setPhase(listeningRef.current ? "listening" : "idle");
    }
  }

  async function startTalking(): Promise<void> {
    if (lockRef.current || messagesRef.current.length > 0) {
      return;
    }
    if (!requireReady()) {
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
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

  async function refreshUpdate(): Promise<void> {
    if (!desktop) {
      setUpdateError("Open the desktop app to check GitHub.");
      return;
    }
    setUpdateError(null);
    try {
      setUpdate(await checkUpdate());
    } catch (error: unknown) {
      setUpdateError(toCommandError(error).message);
    }
  }

  async function installUpdate(): Promise<void> {
    if (!desktop) {
      setUpdateError("Open the desktop app to install an update.");
      return;
    }
    setUpdating(true);
    setUpdateError(null);
    setUpdateReceived(0);
    setUpdateTotal(0);
    try {
      await applyUpdate();
    } catch (error: unknown) {
      setUpdating(false);
      setUpdateError(toCommandError(error).message);
    }
  }

  const total = usageTotal(session.usage);
  const budget = session.preferences.dailyTokenBudget;
  const ready = session.groqConfigured && session.cartesiaConfigured;
  const shell = layout === "center" ? "max-w-3xl" : "max-w-5xl";
  const scene =
    layout === "split"
      ? "grid items-start gap-8 md:grid-cols-[minmax(0,1fr)_auto]"
      : "flex w-full flex-col items-center gap-8";
  const stage = (
    <Stage
      layout={layout}
      youSaid={youSaid}
      notes={latestNotes}
      earlier={earlierNotes}
      tollySaid={tollySaid}
      heardYou={heardYou}
      keysReady={ready}
      onOpenSettings={() => setSettingsOpen(true)}
      onStartTalking={() => void startTalking()}
    />
  );

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <header className="border-b border-line/80 bg-paper/80 px-6 py-3 backdrop-blur">
        <div className={`mx-auto flex ${shell} items-center justify-between gap-4`}>
          <div>
            <p className="text-sm font-medium tracking-[0.32em] text-accent">TOLLY</p>
            <p className="mt-1 text-xs text-muted">v{session.version}</p>
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
              <p className="text-2xl font-medium leading-none tracking-tight text-accent">{skillRating ?? "—"}</p>
              <p className="text-xs text-muted">{skillRating === null ? "Not yet" : speakingBand(skillRating)}</p>
            </div>
            <p className={budgetNote ? "text-sm text-accent" : "hidden text-sm text-muted sm:block"}>
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
        {budgetNote && <p className={`mx-auto mt-2 ${shell} text-sm text-accent`}>{budgetNote}</p>}
        {!desktop && (
          <p className={`mx-auto mt-2 ${shell} text-sm text-muted`}>
            Browser preview. Key storage, Groq, and Cartesia run inside the portable desktop app.
          </p>
        )}
      </header>
      {update?.available && (
        <div className="border-b border-line bg-note px-6 py-2">
          <div className={`mx-auto flex ${shell} items-center justify-between gap-3 text-sm`}>
            <p>Version {update.latest} is on GitHub.</p>
            <button
              type="button"
              className="rounded-full bg-ink px-3 py-1 text-paper disabled:opacity-50"
              disabled={updating}
              onClick={() => void installUpdate()}
            >
              {updating ? "Installing…" : "Update"}
            </button>
          </div>
        </div>
      )}
      {rateLimit && <RateLimitBanner error={rateLimit} onDismiss={() => setRateLimit(null)} />}
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="tech-grid pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className={`relative mx-auto w-full ${shell} px-6 py-6 ${scene}`}>
          {layout === "split" && <div className="order-2 min-w-0 w-full md:order-1">{stage}</div>}
          <div className={layout === "split" ? "order-1 md:order-2" : ""}>
            <Presence phase={phase} micOpen={micOpen} />
          </div>
          {layout !== "split" && <div className="w-full">{stage}</div>}
        </div>
      </main>
      <footer className="border-t border-line bg-paper/95 px-6 py-3">
        <TalkButton
          phase={phase}
          notice={notice}
          micOpen={micOpen}
          onShortPress={() => void onShortPress()}
          onHoldStart={() => void holdStart()}
          onHoldEnd={() => void holdEnd()}
        />
      </footer>
      {settingsOpen && (
        <SettingsModal
          session={session}
          update={update}
          updateError={updateError}
          updating={updating}
          updateReceived={updateReceived}
          updateTotal={updateTotal}
          onCheckUpdate={() => void refreshUpdate()}
          onApplyUpdate={() => void installUpdate()}
          onClose={() => {
            setAppearanceDraft(null);
            setSettingsOpen(false);
          }}
          onSession={setSession}
          onAppearance={setAppearanceDraft}
        />
      )}
    </div>
  );
}
