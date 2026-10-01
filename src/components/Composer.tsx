import { useRef, useState } from "react";

import type { MicLevel } from "../lib/audio";
import type { Phase } from "../types";
import { VoiceBar } from "./VoiceBar";

type TalkDockProps = {
  phase: Phase;
  notice: string | null;
  micOpen: boolean;
  reading: MicLevel;
  canReplay: boolean;
  onShortPress: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onEnd: () => void;
  onReplay: () => void;
};

const HOLD_MS = 220;

export function TalkDock({
  phase,
  notice,
  micOpen,
  reading,
  canReplay,
  onShortPress,
  onHoldStart,
  onHoldEnd,
  onEnd,
  onReplay,
}: TalkDockProps) {
  const holdTimer = useRef<number | null>(null);
  const holding = useRef(false);
  const [pressing, setPressing] = useState(false);
  const speaking = phase === "speaking";
  const listening = phase === "listening" || micOpen;
  const busy = phase === "thinking" || phase === "transcribing";

  function clearHoldTimer(): void {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  const caption = pressing
    ? "Release to send"
    : speaking
      ? "Tap to cut in"
      : busy
        ? "Tap to stop"
        : listening
          ? "Listening. Tap to pause."
          : "Tap to speak";

  return (
    <div className="flex flex-col items-center gap-2">
      <VoiceBar reading={reading} open={micOpen || listening || pressing} />
      <div className="flex items-start gap-7">
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            className="dock-button"
            aria-label="End. Close the microphone and stop Tolly."
            disabled={!listening && !speaking && !busy}
            onClick={onEnd}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
          <span className="text-[0.65rem] text-muted">End</span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            className={`mic${listening ? " is-live" : ""}${speaking ? " is-speaking" : ""}${pressing ? " is-holding" : ""}`}
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
            <MicMark interrupt={speaking} />
          </button>
          <span className="text-xs font-medium" aria-live="polite">
            {caption}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            className="dock-button"
            aria-label="Replay Tolly's last line"
            disabled={!canReplay || speaking || busy}
            onClick={onReplay}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M4 10a1 1 0 0 1 1-1h2.2a7 7 0 0 1 12.4 3.3 1 1 0 1 1-2 .3A5 5 0 0 0 8.9 11H11a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1v-6a1 1 0 1 1 2 0v4Z" />
            </svg>
          </button>
          <span className="text-[0.65rem] text-muted">Replay</span>
        </div>
      </div>
      {notice && <p className="text-center text-xs text-danger">{notice}</p>}
    </div>
  );
}

function MicMark({ interrupt }: { interrupt: boolean }) {
  if (interrupt) {
    return (
      <span className="flex gap-1.5" aria-hidden="true">
        <span className="block h-5 w-1.5 rounded-full bg-white" />
        <span className="block h-5 w-1.5 rounded-full bg-white" />
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"
      />
    </svg>
  );
}
