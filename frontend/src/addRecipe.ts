import type { Difficulty, Duplicate, Ingested, QueuedIngest, Sync } from "./api/client";

// Why the API refused: a duplicate names the recipe or Queued Ingest the Source already is, and a
// conflict is a race worth retrying.
type Refusal =
  | { kind: "duplicate"; duplicate: Duplicate }
  | { kind: "conflict" | "not-an-editor" | "failed" };

export type IngestOutcome =
  | { kind: "ingested"; ingested: Ingested }
  | { kind: "queued"; queuedIngest: QueuedIngest }
  | { kind: "not-found" | "invalid" }
  | Refusal;

export type SaveOutcome = { kind: "saved" } | Refusal;

type Answer<T> = { data?: T; error?: unknown; response: Response };

// A 409 that names neither a recipe nor a Queued Ingest is a conflict. A 403 is not-an-editor only
// when the body is the API's JSON: the WAF's rate-limit block is a 403 too.
function refusal({ error, response }: Answer<unknown>): Refusal {
  const body = typeof error === "object" && error !== null ? error : undefined;
  if (response.status === 409 && body) {
    const duplicate = body as Duplicate;
    return duplicate.recipe_id || duplicate.queued_ingest_id
      ? { kind: "duplicate", duplicate }
      : { kind: "conflict" };
  }
  if (response.status === 403 && body && "detail" in body) return { kind: "not-an-editor" };
  return { kind: "failed" };
}

// What `POST /api/ingest` answered: the Original to review (200), a Queued Ingest (202), the
// recipe or Queued Ingest the Source already is (409), or why nothing happened.
export function ingestOutcome(answer: Answer<Ingested | QueuedIngest>): IngestOutcome {
  const { data, response } = answer;
  if (response.status === 200 && data) return { kind: "ingested", ingested: data as Ingested };
  if (response.status === 202 && data)
    return { kind: "queued", queuedIngest: data as QueuedIngest };
  if (response.status === 404) return { kind: "not-found" };
  if (response.status === 422) return { kind: "invalid" };
  return refusal(answer);
}

// What `POST /api/recipes` answered: saved (201), or why not.
export function saveOutcome(answer: Answer<unknown>): SaveOutcome {
  return answer.response.status === 201 ? { kind: "saved" } : refusal(answer);
}

// Adding a recipe is never queued, so it's off offline and in the read-only modes, which behave
// like offline. Null while it's open, including before the first sync poll answers.
export function editBlock(
  online: boolean,
  sync: Sync | null | undefined,
): "offline" | "paused" | null {
  if (!online) return "offline";
  return sync?.read_only ? "paused" : null;
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
