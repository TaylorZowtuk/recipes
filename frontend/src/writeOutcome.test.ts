import { describe, expect, it } from "vitest";
import type { Sync } from "./api/client";
import { editBlock } from "./writeOutcome";

describe("editBlock", () => {
  const open: Sync = { collection_version: 3, schema_version: 1, read_only: null, weeks: null };

  it("is nothing online with the API open, or while sync is still loading", () => {
    expect(editBlock(true, open)).toBeNull();
    expect(editBlock(true, undefined)).toBeNull();
  });

  it("is offline without a network, whatever sync said", () => {
    expect(editBlock(false, open)).toBe("offline");
    expect(editBlock(false, { ...open, read_only: "updating" })).toBe("offline");
  });

  it("is paused while the API is read-only", () => {
    expect(editBlock(true, { ...open, read_only: "updating" })).toBe("paused");
  });
});
