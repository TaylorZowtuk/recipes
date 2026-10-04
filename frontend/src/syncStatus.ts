import type { Sync } from "./api/client";

export type SyncPoll = {
  /** The last `/api/sync` response, or null when the poll failed. */
  sync: Sync | null;
  online: boolean;
};

// The read-only banners from the offline cache and sync ADR.
export function syncStatus({ sync, online }: SyncPoll): string {
  if (!online) {
    return "Offline — ticks will sync later.";
  }
  if (!sync) {
    return "Editing is paused.";
  }
  if (sync.read_only === "updating") {
    return "Updating — editing is back in a few minutes.";
  }
  return `Up to date · collection v${sync.collection_version}`;
}
