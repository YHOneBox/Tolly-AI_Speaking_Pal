import { rateLimitCopy } from "../lib/errors";
import type { CommandError } from "../types";

type RateLimitBannerProps = {
  error: CommandError;
  onDismiss: () => void;
};

export function RateLimitBanner({ error, onDismiss }: RateLimitBannerProps) {
  return (
    <div className="border-b border-line bg-note px-6 py-3 text-sm text-ink" role="status">
      <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
        <p>
          <span className="font-semibold">Rate limit. </span>
          {rateLimitCopy(error)} This is your own Groq or Cartesia quota, not an app-wide cap.
        </p>
        <button type="button" className="shrink-0 text-muted underline-offset-2 hover:underline" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
