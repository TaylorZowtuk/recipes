import { describe, expect, it } from "vitest";
import { syncStatus } from "./syncStatus";

describe("syncStatus", () => {
  it("names the collection version when editing is open", () => {
    expect(
      syncStatus({ collection_version: 3, schema_version: 1, read_only: null, weeks: null }),
    ).toBe("Up to date · collection v3");
  });

  it("warns that editing is paused while the app is updating", () => {
    expect(
      syncStatus({ collection_version: 3, schema_version: 1, read_only: "updating", weeks: null }),
    ).toBe("Updating — editing is back in a few minutes.");
  });
});
