import type { Sync } from "./api/client";

export function syncStatus(sync: Sync): string {
  if (sync.read_only === "updating") {
    return "Updating — editing is back in a few minutes.";
  }
  return `Up to date · collection v${sync.collection_version}`;
}
