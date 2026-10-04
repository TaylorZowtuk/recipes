import { describe, expect, it } from "vitest";
import type { Sync } from "./api/client";
import { syncStatus } from "./syncStatus";

const open: Sync = { collection_version: 3, schema_version: 1, read_only: null, weeks: null };

describe("syncStatus", () => {
  it("names the collection version when editing is open", () => {
    expect(syncStatus({ sync: open, online: true })).toBe("Up to date · collection v3");
  });

  it("warns that editing is paused while the app is updating", () => {
    expect(syncStatus({ sync: { ...open, read_only: "updating" }, online: true })).toBe(
      "Updating — editing is back in a few minutes.",
    );
  });

  it("says ticks will sync later when the phone is offline", () => {
    expect(syncStatus({ sync: null, online: false })).toBe("Offline — ticks will sync later.");
  });

  it("says editing is paused when the API is unreachable but the network is up", () => {
    expect(syncStatus({ sync: null, online: true })).toBe("Editing is paused.");
  });
});
