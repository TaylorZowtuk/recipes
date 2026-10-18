import { describe, expect, it } from "vitest";
import { backTarget } from "./back";

describe("backTarget", () => {
  it("steps back through history after navigating within the app", () => {
    expect(backTarget("k3j9x2")).toBe(-1);
  });

  it("falls back to Recipes when the screen was the first one opened", () => {
    // React Router gives the first history entry the key "default".
    expect(backTarget("default")).toBe("/recipes");
  });
});
