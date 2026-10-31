import type { Sync } from "./api/client";

// What an API write answered, as `api` returns it.
export type Answer<T> = { data?: T; error?: unknown; response: Response };

// Why the API refused a write.
export type WriteRefusal = { kind: "conflict" | "not-an-editor" | "failed" };

// The API's JSON error body, or undefined when something else answered, such as the WAF.
export function apiError(error: unknown): object | undefined {
  return typeof error === "object" && error !== null ? error : undefined;
}

// A 409 from the API is a conflict. A 403 is not-an-editor only when the body is the API's JSON:
// the WAF's rate-limit block is a 403 too.
export function writeRefusal({ error, response }: Answer<unknown>): WriteRefusal {
  const body = apiError(error);
  if (response.status === 409 && body) return { kind: "conflict" };
  if (response.status === 403 && body && "detail" in body) return { kind: "not-an-editor" };
  return { kind: "failed" };
}

// A write at a recipe's version: a 404 from the API is a conflict too, since another device
// deleted the recipe, and like a stale version it calls for reloading, not retrying.
export function versionedRefusal(answer: Answer<unknown>): WriteRefusal {
  return answer.response.status === 404 && apiError(answer.error)
    ? { kind: "conflict" }
    : writeRefusal(answer);
}

// Writes are never queued, so they're off offline and in the read-only modes, which behave like
// offline. Null while they're open, including before the first sync poll answers.
export function editBlock(
  online: boolean,
  sync: Sync | null | undefined,
): "offline" | "paused" | null {
  if (!online) return "offline";
  return sync?.read_only ? "paused" : null;
}
