import type { MicLevel } from "../lib/audio";

const SEGMENTS = 28;
// The speech threshold sits near this segment. Anything beyond it counts as a voice when the shape fits.
const THRESHOLD_AT = 9;

type VoiceBarProps = {
  reading: MicLevel;
  open: boolean;
};

export function VoiceBar({ reading, open }: VoiceBarProps) {
  const lit = open ? Math.round(reading.level * SEGMENTS) : 0;
  const label = !open
    ? "Microphone is closed"
    : reading.voiced
      ? "Hearing your voice"
      : lit > 0
        ? "Hearing sound, not a voice"
        : "Quiet";
  return (
    <div className="flex flex-col items-center gap-1" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={SEGMENTS} aria-valuenow={lit} aria-valuetext={label}>
      <div className="meter">
        {Array.from({ length: SEGMENTS }, (_, index) => {
          const center = Math.abs(index - (SEGMENTS - 1) / 2) / ((SEGMENTS - 1) / 2);
          const height = 35 + Math.round((1 - center) * 65);
          const isLit = index < lit;
          const className = isLit
            ? reading.voiced
              ? "is-lit is-voiced"
              : "is-lit"
            : index === THRESHOLD_AT
              ? "is-threshold"
              : "";
          return <span key={index} className={className} style={{ height: `${height}%` }} />;
        })}
      </div>
      <p className="text-[0.65rem] uppercase tracking-[0.16em] text-muted">{label}</p>
    </div>
  );
}
