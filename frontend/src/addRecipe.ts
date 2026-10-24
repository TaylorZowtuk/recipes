import type { Difficulty, Duplicate, Ingested, QueuedIngest } from "./api/client";

export type IngestOutcome =
  | { kind: "ingested"; ingested: Ingested }
  | { kind: "queued"; queuedIngest: QueuedIngest }
  | { kind: "duplicate"; duplicate: Duplicate }
  | { kind: "not-found" | "invalid" | "not-an-editor" | "failed" };

// What `POST /api/ingest` answered: the Original to review (200), a Queued Ingest (202), the
// recipe or Queued Ingest the Source already is (409), or why nothing happened.
export function ingestOutcome({
  data,
  error,
  response,
}: {
  data?: Ingested | QueuedIngest;
  error?: unknown;
  response: Response;
}): IngestOutcome {
  if (response.status === 200 && data) return { kind: "ingested", ingested: data as Ingested };
  if (response.status === 202 && data)
    return { kind: "queued", queuedIngest: data as QueuedIngest };
  if (response.status === 409 && error) return { kind: "duplicate", duplicate: error as Duplicate };
  if (response.status === 404) return { kind: "not-found" };
  if (response.status === 422) return { kind: "invalid" };
  if (response.status === 403) return { kind: "not-an-editor" };
  return { kind: "failed" };
}

// Tags typed as one comma-separated line, trimmed, with blanks and repeats (ignoring case) dropped.
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export type DifficultyChoice = Partial<Difficulty>;

// Difficulty is optional, but a saved one rates all three of Prep, Cook and Cleanup.
export function chosenDifficulty(
  choice: DifficultyChoice,
): { complete: true; difficulty: Difficulty | null } | { complete: false } {
  const { prep, cook, cleanup } = choice;
  if (prep && cook && cleanup) return { complete: true, difficulty: { prep, cook, cleanup } };
  if (!prep && !cook && !cleanup) return { complete: true, difficulty: null };
  return { complete: false };
}
