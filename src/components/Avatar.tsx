import type { Phase } from "../types";

type FaceProps = {
  phase: Phase;
  small?: boolean;
};

export function Face({ phase, small = false }: FaceProps) {
  const mood =
    phase === "speaking"
      ? " is-speaking"
      : phase === "listening"
        ? " is-listening"
        : phase === "thinking" || phase === "transcribing"
          ? " is-thinking"
          : "";
  return (
    <div className={`face${small ? " is-small" : ""}${mood}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none">
        <g className="face-eye" style={{ transformOrigin: "20px 26px" }}>
          <path d="M14 27c2.5-4 9.5-4 12 0" stroke="#0b1020" strokeWidth="4.5" strokeLinecap="round" />
        </g>
        <g className="face-eye" style={{ transformOrigin: "44px 26px" }}>
          <path d="M38 27c2.5-4 9.5-4 12 0" stroke="#0b1020" strokeWidth="4.5" strokeLinecap="round" />
        </g>
        <path d="M22 40c4 6 16 6 20 0" stroke="#0b1020" strokeWidth="4.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

type WaveProps = {
  phase: Phase;
  level: number;
};

export function Wave({ phase, level }: WaveProps) {
  const speaking = phase === "speaking";
  const shape = [0.45, 0.8, 1, 0.7, 0.5];
  return (
    <div className={`wave${speaking ? " is-speaking" : ""}`} aria-hidden="true">
      {shape.map((weight, index) => (
        <span
          key={index}
          style={speaking ? undefined : { height: `${Math.max(18, Math.round(level * weight * 100))}%` }}
        />
      ))}
    </div>
  );
}

type PresenceProps = {
  phase: Phase;
  level: number;
};

export function Presence({ phase, level }: PresenceProps) {
  return (
    <div className="flex items-center justify-center gap-4">
      <Wave phase={phase} level={level} />
      <Face phase={phase} />
      <Wave phase={phase} level={level} />
    </div>
  );
}
