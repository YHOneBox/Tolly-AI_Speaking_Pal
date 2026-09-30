import { useEffect, useRef } from "react";

import type { CaptureMode, ChatMessage } from "../types";

type ChatTranscriptProps = {
  messages: ChatMessage[];
  keysReady: boolean;
  captureMode: CaptureMode;
  onOpenSettings: () => void;
  onStartTalking: () => void;
};

export function ChatTranscript({
  messages,
  keysReady,
  captureMode,
  onOpenSettings,
  onStartTalking,
}: ChatTranscriptProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-full flex-col">
        <div className="m-auto w-full max-w-xl px-6 py-8 text-center">
          <p className="font-serif text-4xl text-ink">Hey.</p>
          <p className="mt-4 text-base leading-7 text-muted">
            Say something, or let me start. We can wander onto whatever comes up.
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">
            {captureMode === "hold"
              ? "Hold the button while you speak, then release."
              : "Voice detection sends your speech after you pause."}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              className="rounded-full bg-ink px-4 py-2 text-sm text-paper"
              onClick={onStartTalking}
            >
              You start
            </button>
            {!keysReady && (
              <button
                type="button"
                className="rounded-full border border-line bg-card px-4 py-2 text-sm"
                onClick={onOpenSettings}
              >
                Add API keys
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8">
      {messages.map((message) => (
        <article
          key={message.id}
          className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
        >
          <div className={message.role === "user" ? "max-w-[80%]" : "max-w-[85%]"}>
            <p className="mb-1 text-xs uppercase tracking-[0.14em] text-muted">
              {message.role === "user" ? "You" : "Tolly"}
            </p>
            <div
              className={
                message.role === "user"
                  ? "rounded-2xl rounded-br-md bg-ink px-4 py-3 text-paper"
                  : "rounded-2xl rounded-bl-md border border-line bg-card px-4 py-3 text-ink"
              }
            >
              <p className="whitespace-pre-wrap leading-7">{message.text}</p>
            </div>
            {message.role === "assistant" && message.feedback && message.feedback.length > 0 && (
              <ul className="mt-2 space-y-1 rounded-xl bg-note px-3 py-2 text-sm leading-6 text-ink">
                {message.feedback.map((note, index) => (
                  <li key={`${message.id}-${index}`}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}
