import { useRef, useState } from "react";

import type { Phase } from "../types";

type TalkProps = {
  phase: Phase;
  notice: string | null;
  micOpen: boolean;
  onShortPress: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
};

const HOLD_MS = 220;

export function Presence({ phase, micOpen }: { phase: Phase; micOpen: boolean }) {
  const speaking = phase === "speaking";
  const listening = phase === "listening" || micOpen;
  const thinking = phase === "thinking" || phase === "transcribing";
  const status = speaking ? "Speaking" : thinking ? "Thinking" : listening ? "Listening" : "Idle";

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-[0.65rem] uppercase tracking-[0.22em] text-accent">{status}</p>
      <div
        className={`presence${listening ? " is-live" : ""}${speaking ? " is-speaking" : ""}${thinking ? " is-thinking" : ""}`}
        aria-hidden="true"
      >
        <span className="presence-halo" />
        <span className="presence-ring" />
        <span className="presence-ring-inner" />
        <span className="presence-core">
          <span className="presence-ticks" />
          <span className="presence-sweep" />
          {speaking ? (
            <span className="presence-bars">
              <span />
              <span />
              <span />
              <span />
              <span />
            </span>
          ) : (
            <span className="presence-nucleus" />
          )}
        </span>
      </div>
    </div>
  );
}

export function TalkButton({
  phase,
  notice,
  micOpen,
  onShortPress,
  onHoldStart,
  onHoldEnd,
}: TalkProps) {
  const holdTimer = useRef<number | null>(null);
  const holding = useRef(false);
  const [pressing, setPressing] = useState(false);
  const speaking = phase === "speaking";
  const listening = phase === "listening" || micOpen;
  const thinking = phase === "thinking" || phase === "transcribing";

  function clearHoldTimer(): void {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  const label = pressing ? "Hold" : speaking ? "Cut in" : thinking ? "Stop" : listening ? "Listening" : "Talk";
  const hint = pressing
    ? "Release to send"
    : speaking
      ? "Tap to cut in, or just start talking"
      : thinking
        ? "Tap to stop"
        : listening
          ? "Hold the button to take the turn."
          : "Tap to talk. Hold while you speak.";

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        className={`talk-control${listening ? " is-live" : ""}${speaking ? " is-speaking" : ""}${pressing ? " is-holding" : ""}`}
        aria-label="Talk to Tolly. Tap to listen, hold to speak, or tap while Tolly is talking to cut in."
        aria-pressed={listening}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          holding.current = false;
          setPressing(false);
          clearHoldTimer();
          holdTimer.current = window.setTimeout(() => {
            holding.current = true;
            setPressing(true);
            onHoldStart();
          }, HOLD_MS);
        }}
        onPointerUp={() => {
          const wasHold = holding.current;
          clearHoldTimer();
          if (wasHold) {
            holding.current = false;
            setPressing(false);
            onHoldEnd();
            return;
          }
          onShortPress();
        }}
        onPointerCancel={() => {
          const wasHold = holding.current;
          clearHoldTimer();
          holding.current = false;
          setPressing(false);
          if (wasHold) {
            onHoldEnd();
          }
        }}
      >
        <TalkMark interrupt={speaking} />
        <span>{label}</span>
      </button>
      <p className="mt-2 text-center text-xs leading-5 text-muted" aria-live="polite">
        {hint}
      </p>
      {notice && <p className="mt-1 text-center text-xs text-danger">{notice}</p>}
    </div>
  );
}

function TalkMark({ interrupt }: { interrupt: boolean }) {
  if (interrupt) {
    return (
      <span className="flex gap-1" aria-hidden="true">
        <span className="block h-3.5 w-1 rounded-full bg-ink" />
        <span className="block h-3.5 w-1 rounded-full bg-ink" />
      </span>
    );
  }
  return (
    <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"
      />
    </svg>
  );
}
