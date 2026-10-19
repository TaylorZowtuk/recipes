import { describe, expect, it } from "vitest";
import { backTarget } from "./back";

describe("backTarget", () => {
  it("steps back through history after navigating within the app", () => {
    expect(backTarget(2)).toBe(-1);
  });

  it("falls back to Recipes when the screen is the app's first history entry", () => {
    // React Router numbers its history entries from 0, starting where the app was opened.
    expect(backTarget(0)).toBe("/recipes");
  });

  it("falls back to Recipes when there is no history index", () => {
    expect(backTarget(undefined)).toBe("/recipes");
  });
});
