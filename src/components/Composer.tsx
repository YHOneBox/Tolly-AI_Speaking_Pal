import { useRef } from "react";

import type { CaptureMode, Phase } from "../types";

type ComposerProps = {
  draft: string;
  phase: Phase;
  notice: string | null;
  captureMode: CaptureMode;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onToggleMic: () => void;
  onCaptureMode: (mode: CaptureMode) => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
};

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking",
};

export function Composer({
  draft,
  phase,
  notice,
  captureMode,
  onDraftChange,
  onSubmit,
  onToggleMic,
  onCaptureMode,
  onHoldStart,
  onHoldEnd,
}: ComposerProps) {
  const holdGesture = useRef(false);
  const busy = phase === "transcribing" || phase === "thinking" || phase === "speaking";
  const listening = phase === "listening";
  const holdMode = captureMode === "hold";
  const buttonLabel = holdMode ? (listening ? "Release" : busy ? "Stop" : "Hold") : listening || busy ? "Stop" : "Mic";

  return (
    <form
      className="border-t border-line bg-paper px-6 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="mx-auto mb-3 flex max-w-3xl justify-center">
        <div className="grid grid-cols-2 rounded-full border border-line bg-card p-1 text-sm" role="group" aria-label="Microphone mode">
          <ModeButton active={captureMode === "hold"} onClick={() => onCaptureMode("hold")}>
            Hold to speak
          </ModeButton>
          <ModeButton active={captureMode === "vad"} onClick={() => onCaptureMode("vad")}>
            Voice detection
          </ModeButton>
        </div>
      </div>
      <div className="mx-auto flex max-w-3xl items-end gap-3">
        <button
          type="button"
          className="relative grid h-14 min-w-14 shrink-0 touch-none place-items-center rounded-full bg-accent px-3 text-sm font-semibold text-white shadow-sm select-none hover:bg-accent-dark disabled:opacity-60"
          aria-pressed={listening}
          onPointerDown={(event) => {
            if (!holdMode || busy) {
              return;
            }
            holdGesture.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            onHoldStart();
          }}
          onPointerUp={() => {
            if (holdMode) {
              onHoldEnd();
            }
          }}
          onPointerCancel={() => {
            if (holdMode) {
              onHoldEnd();
            }
          }}
          onClick={() => {
            if (holdMode && holdGesture.current) {
              holdGesture.current = false;
              return;
            }
            onToggleMic();
          }}
        >
          {listening && <span className="listen-ring absolute inset-0 rounded-full bg-accent" />}
          <span className="relative">{buttonLabel}</span>
        </button>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Message</span>
          <textarea
            value={draft}
            rows={2}
            placeholder="Or type whatever's on your mind"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="w-full resize-none rounded-2xl border border-line bg-card px-4 py-3 leading-6 text-ink outline-none focus:border-accent"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
        </label>
        <button
          type="submit"
          className="h-14 rounded-full bg-ink px-5 text-sm text-paper disabled:opacity-50"
          disabled={busy || draft.trim().length === 0}
        >
          Send
        </button>
      </div>
      <div className="mx-auto mt-2 flex max-w-3xl items-center justify-between gap-3 text-sm">
        <p className="text-muted" aria-live="polite">
          {PHASE_LABEL[phase]}
          {listening && holdMode ? " · release to send" : ""}
          {listening && !holdMode ? " · pause when you finish a thought" : ""}
        </p>
        {notice && <p className="text-right text-danger">{notice}</p>}
      </div>
    </form>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={
        active ? "rounded-full bg-ink px-4 py-1.5 text-paper" : "rounded-full px-4 py-1.5 text-muted hover:text-ink"
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}
