import type { Sync } from "./api/client";

export type SyncPoll = {
  /** The last `/api/sync` response: undefined before the first answers, null when it failed. */
  sync: Sync | null | undefined;
  online: boolean;
};

// The editor's read-only banner from the offline cache and sync ADR, or null when editing is open.
export function syncStatus({ sync, online }: SyncPoll): string | null {
  if (!online) return "Offline — ticks will sync later.";
  if (sync === null) return "Editing is paused.";
  if (sync?.read_only === "updating") return "Updating — editing is back in a few minutes.";
  return null;
}
