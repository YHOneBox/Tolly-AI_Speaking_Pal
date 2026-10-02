import type { AppLayout, Persona, Phase } from "../types";
import { Face } from "./Avatar";

type StageProps = {
  layout: AppLayout;
  phase: Phase;
  persona: Persona;
  youSaid: string | null;
  notes: string[];
  earlier: string[];
  tollySaid: string | null;
  heardYou: boolean;
  keysReady: boolean;
  onOpenSettings: () => void;
  onStartTalking: () => void;
};

export function Stage({
  layout,
  phase,
  persona,
  youSaid,
  notes,
  earlier,
  tollySaid,
  heardYou,
  keysReady,
  onOpenSettings,
  onStartTalking,
}: StageProps) {
  if (!heardYou && !tollySaid) {
    return (
      <div className="mx-auto w-full max-w-md text-center">
        {persona.emoji && (
          <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-note text-3xl" aria-hidden="true">
            {persona.emoji}
          </span>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">Hi there!</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          {phase === "listening"
            ? `${persona.name} is listening. Just start talking, or hold the microphone while you speak.`
            : `Tap the microphone and say anything, or hold it while you speak.`}{" "}
          {persona.name} answers like a friend, and quiet grammar notes show up here.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button type="button" className="btn-primary rounded-full px-5 py-2.5 text-sm font-medium" onClick={onStartTalking}>
            Let {persona.name} start
          </button>
          {!keysReady && (
            <button type="button" className="pill rounded-full px-5 py-2.5 text-sm" onClick={onOpenSettings}>
              Add API keys
            </button>
          )}
        </div>
      </div>
    );
  }

  const conversation = (
    <div className="space-y-3">
      {youSaid && (
        <div className="pill rounded-2xl px-4 py-3">
          <p className="text-xs font-medium text-accent-dark">You</p>
          <p className="mt-1 text-base leading-6">{youSaid}</p>
        </div>
      )}
      {tollySaid && (
        <div className="flex items-start gap-3">
          {persona.emoji ? (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-note text-base" aria-hidden="true">
              {persona.emoji}
            </span>
          ) : (
            <Face phase={phase} small />
          )}
          <div className="pill min-w-0 flex-1 rounded-2xl rounded-tl-md px-4 py-3">
            <p className="text-xs font-medium text-accent">{persona.name}</p>
            <p className="mt-1 text-base leading-6">{tollySaid}</p>
          </div>
        </div>
      )}
    </div>
  );

  const grammar = heardYou ? (
    <GrammarCard notes={notes} earlier={earlier} />
  ) : null;

  if (layout === "split") {
    return (
      <div className="grid w-full gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>{conversation}</div>
        <div>{grammar}</div>
      </div>
    );
  }

  return (
    <div className={layout === "center" ? "mx-auto w-full max-w-2xl space-y-5" : "w-full space-y-5"}>
      {conversation}
      {grammar}
    </div>
  );
}

function GrammarCard({ notes, earlier }: { notes: string[]; earlier: string[] }) {
  const corrections = notes.map(splitCorrection);
  const tips = notes.filter((_, index) => corrections[index] === null);
  const pairs = corrections.filter((item): item is { right: string; wrong: string } => item !== null);

  return (
    <section className="rounded-2xl border border-line bg-card px-4 py-4" aria-label="Grammar correction">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-note text-accent" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h16" />
            <path d="m6 16 9.5-9.5a2.1 2.1 0 0 1 3 3L9 19H6z" />
          </svg>
        </span>
        <h2 className="text-sm font-semibold">Grammar Correction</h2>
      </div>

      {notes.length === 0 ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-note px-4 py-3">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-success/20 text-success" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5L20 7" />
            </svg>
          </span>
          <p className="text-sm">That sounded clear. Nothing to fix.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {pairs.map((pair, index) => (
            <div key={`${index}-${pair.right}`} className="space-y-2 rounded-xl bg-note px-4 py-3">
              <p className="flex items-start gap-2 text-sm leading-6">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                <span className="text-muted line-through decoration-danger/70">{pair.wrong}</span>
              </p>
              <p className="flex items-start gap-2 text-base leading-6">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span className="font-medium text-success">{pair.right}</span>
              </p>
            </div>
          ))}
          {tips.length > 0 && (
            <div className="rounded-xl border border-line px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Tip</p>
              <ul className="mt-1 space-y-1 text-sm leading-6">
                {tips.map((tip, index) => (
                  <li key={`${index}-${tip}`}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {earlier.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">Earlier notes ({earlier.length})</summary>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-muted">
            {earlier.map((note, index) => (
              <li key={`${index}-${note}`}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function splitCorrection(note: string): { right: string; wrong: string } | null {
  const match = note.match(/say\s+["“](.+?)["”]\s+instead of\s+["“](.+?)["”]/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { right: match[1], wrong: match[2] };
}
