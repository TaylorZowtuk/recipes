import type { Difficulty, Duplicate, Image, Ingested, Preview, QueuedIngest } from "./api/client";
import { type Answer, apiError, type WriteRefusal, writeRefusal } from "./writeOutcome";

// Why the API refused: a duplicate names the recipe or Queued Ingest the Source already is, and a
// conflict is a race worth retrying.
export type Refusal = { kind: "duplicate"; duplicate: Duplicate } | WriteRefusal;

export type IngestOutcome =
  | { kind: "ingested"; ingested: Ingested }
  | { kind: "queued"; queuedIngest: QueuedIngest }
  | { kind: "not-found" | "invalid" }
  | Refusal;

export type SaveOutcome = { kind: "saved" } | Refusal;

// A 409 that names a recipe or a Queued Ingest is a duplicate; anything else is a write refusal.
export function refusal(answer: Answer<unknown>): Refusal {
  const duplicate =
    answer.response.status === 409 ? (apiError(answer.error) as Duplicate | undefined) : undefined;
  return duplicate?.recipe_id || duplicate?.queued_ingest_id
    ? { kind: "duplicate", duplicate }
    : writeRefusal(answer);
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

// A Candidate Photo on the review screen: being stored, stored, or unavailable (dropped).
export type Candidate =
  | { url: string; state: "storing" | "unavailable" }
  | { url: string; state: "stored"; image: Image };

// The candidates that stored, in the order ingest found them. Two that are the same photo are
// one stored image, so it's kept once.
export function storedImages(candidates: Candidate[]): Image[] {
  const seen = new Set<string>();
  return candidates.flatMap((c) => {
    if (c.state !== "stored" || seen.has(c.image.id)) return [];
    seen.add(c.image.id);
    return [c.image];
  });
}

// How many candidates are still storing. Save waits for none, so a save keeps every one that
// stored.
export function stillStoring(candidates: Candidate[]): number {
  return candidates.filter((c) => c.state === "storing").length;
}

// Until the editor chooses, the Preview Photo is the first stored candidate, centred.
export function defaultPreview(candidates: Candidate[]): Preview | null {
  const [first] = storedImages(candidates);
  return first ? { image_id: first.id, focal_x: 0.5, focal_y: 0.5 } : null;
}

// The editor's choice of Preview Photo: undefined until they choose, then a photo, or null for
// No photo.
export type PhotoChoice = Preview | null | undefined;

// The editor's choice stands once made, No photo included. Until then it's the default, but only
// once every candidate has settled: while one stores it's undecided, so no option looks chosen.
// So undefined here means a candidate is still storing, not just that the editor hasn't chosen.
export function previewPhoto(candidates: Candidate[], choice: PhotoChoice): PhotoChoice {
  if (choice !== undefined) return choice;
  return stillStoring(candidates) > 0 ? undefined : defaultPreview(candidates);
}

// Each deployed API runs only 3 requests at once, shared with the sync poll, and answers 429 (or
// 503) over that. So at most 2 candidates store at a time, and a 429 or 503 is tried twice more,
// 1 s then 2 s later; any other refusal is final.
const IN_FLIGHT = 2;
const RETRY_DELAYS_MS = [1000, 2000];
const RETRIED = new Set([429, 503]);

async function storeCandidate(
  url: string,
  store: (url: string) => Promise<Answer<Image>>,
  stopped: () => boolean,
): Promise<Candidate> {
  for (const delay of [...RETRY_DELAYS_MS, undefined]) {
    let answer: Answer<Image>;
    try {
      answer = await store(url);
    } catch {
      return { url, state: "unavailable" };
    }
    const { data, response } = answer;
    if (response.ok && data) return { url, state: "stored", image: data };
    if (delay === undefined || !RETRIED.has(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (stopped()) break;
  }
  return { url, state: "unavailable" };
}

// Stores each Candidate Photo through `store`, settling each as it stores or turns out
// unavailable. Once `stopped`, it starts no request and settles nothing more.
export async function storeCandidates(
  urls: string[],
  store: (url: string) => Promise<Answer<Image>>,
  settle: (candidate: Candidate) => void,
  stopped: () => boolean,
): Promise<void> {
  const waiting = [...urls];
  const worker = async () => {
    for (let url = waiting.shift(); url !== undefined; url = waiting.shift()) {
      const candidate = await storeCandidate(url, store, stopped);
      if (stopped()) return;
      settle(candidate);
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
}
