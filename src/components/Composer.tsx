import { useRef, useState } from "react";

import type { Phase } from "../types";

type ComposerProps = {
  phase: Phase;
  notice: string | null;
  micOpen: boolean;
  onShortPress: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
};

const HOLD_MS = 220;

export function Composer({
  phase,
  notice,
  micOpen,
  onShortPress,
  onHoldStart,
  onHoldEnd,
}: ComposerProps) {
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

  const status = pressing ? "Hold" : speaking ? "Speaking" : thinking ? "Thinking" : listening ? "Listening" : "Idle";
  const hint = pressing
    ? "Release to send"
    : speaking
      ? "Tap the body to cut in, or just start talking"
      : thinking
        ? "Tap to stop"
        : listening
          ? "Listening. Hold to take the turn."
          : "Tap to talk. Hold while you speak.";

  return (
    <div className="flex flex-col items-center">
      <p className="mb-3 text-[0.65rem] uppercase tracking-[0.28em] text-accent">{status}</p>
      <button
        type="button"
        className={`presence${listening ? " is-live" : ""}${speaking ? " is-speaking" : ""}${thinking ? " is-thinking" : ""}${pressing ? " is-holding" : ""}`}
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
        <span className="presence-halo" />
        <span className="presence-ring" />
        <span className="presence-ring-inner" />
        <span className="presence-core">
          <span className="presence-ticks" />
          <span className="presence-sweep" />
          {speaking ? (
            <span className="presence-bars" aria-hidden="true">
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
      </button>
      <p className="mt-5 max-w-xs text-center text-sm leading-6 text-muted" aria-live="polite">
        {hint}
      </p>
      {notice && <p className="mt-3 text-center text-sm text-danger">{notice}</p>}
    </div>
  );
}
