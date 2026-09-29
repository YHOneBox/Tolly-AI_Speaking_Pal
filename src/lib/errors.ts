import type { CommandError } from "../types";

export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function toCommandError(error: unknown): CommandError {
  if (isCommandError(error)) {
    return error;
  }
  if (typeof error === "string") {
    return { code: "upstream", message: error };
  }
  if (error instanceof Error) {
    return { code: "upstream", message: error.message };
  }
  return { code: "upstream", message: "Something went wrong." };
}

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

export function rateLimitCopy(error: CommandError): string {
  if (error.retryAfterSecs && error.retryAfterSecs > 0) {
    return `${error.message} Try again in ${error.retryAfterSecs} seconds.`;
  }
  return error.message;
}
