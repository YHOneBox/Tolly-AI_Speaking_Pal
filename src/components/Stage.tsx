import type { AppLayout } from "../types";

type StageProps = {
  layout: AppLayout;
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
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" className="rounded-full bg-ink px-4 py-2 text-sm text-paper" onClick={onStartTalking}>
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
    );
  }

  const align = layout === "center" ? "text-center" : "text-left";
  const width = layout === "center" ? "mx-auto max-w-2xl" : "w-full";

  return (
    <div className={width}>
      {youSaid && (
        <p className={`${align} text-sm leading-6 text-muted`}>
          <span className="uppercase tracking-[0.16em]">You said </span>
          <span className="text-ink">“{youSaid}”</span>
        </p>
      )}
      <div className={youSaid ? "mt-6" : ""}>
        {notes.length > 0 ? (
          <div className="space-y-4">
            {notes.map((note, index) => (
              <NoteCard key={`${index}-${note}`} note={note} align={align} />
            ))}
          </div>
        ) : heardYou ? (
          <div className={`rounded-2xl border border-accent/30 bg-card px-6 py-8 shadow-[0_0_32px_rgba(62,197,255,0.08)] ${align}`}>
            <p className="text-xs uppercase tracking-[0.22em] text-accent">Grammar</p>
            <p className="mt-3 text-4xl font-medium leading-tight tracking-tight">That sounded clear.</p>
          </div>
        ) : (
          <p className={`${align} text-2xl font-medium leading-snug tracking-tight text-ink`}>{tollySaid}</p>
        )}
      </div>
      {tollySaid && (heardYou || notes.length > 0) && (
        <p className={`${align} mt-6 text-base leading-7 text-muted`}>{tollySaid}</p>
      )}
      {earlier.length > 0 && (
        <div className="mt-8 border-t border-line pt-5">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">Earlier</p>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-muted">
            {earlier.map((note, index) => (
              <li key={`${index}-${note}`}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NoteCard({ note, align }: { note: string; align: string }) {
  const parts = splitCorrection(note);
  return (
    <article className={`rounded-2xl border border-accent/35 bg-card px-6 py-7 shadow-[0_0_32px_rgba(62,197,255,0.08)] ${align}`}>
      <p className="text-xs uppercase tracking-[0.22em] text-accent">Clearer</p>
      {parts ? (
        <>
          <p className="mt-3 text-4xl font-medium leading-tight tracking-tight">{parts.right}</p>
          <p className="mt-4 text-lg text-muted line-through decoration-accent/70">{parts.wrong}</p>
        </>
      ) : (
        <p className="mt-3 text-3xl font-medium leading-snug tracking-tight">{note}</p>
      )}
    </article>
  );
}

function splitCorrection(note: string): { right: string; wrong: string } | null {
  const match = note.match(/say\s+["“](.+?)["”]\s+instead of\s+["“](.+?)["”]/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { right: match[1], wrong: match[2] };
}
