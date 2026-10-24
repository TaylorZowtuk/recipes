import { describe, expect, it } from "vitest";
import { accountMenuItems } from "./accountMenu";

const labels = (isEditor: boolean) => accountMenuItems(isEditor).map((item) => item.label);

describe("the account menu", () => {
  it("offers a visitor Kitchen settings and sign-in", () => {
    expect(labels(false)).toEqual(["Kitchen settings", "Sign in"]);
  });

  it("offers an editor Add a recipe, Kitchen settings and sign-out", () => {
    expect(labels(true)).toEqual(["Add a recipe", "Kitchen settings", "Sign out"]);
  });

  it("links to each screen, and signs out in place", () => {
    expect(accountMenuItems(true)).toEqual([
      { label: "Add a recipe", to: "/add" },
      { label: "Kitchen settings", to: "/kitchen-settings" },
      { label: "Sign out", action: "sign-out" },
    ]);
    expect(accountMenuItems(false)).toEqual([
      { label: "Kitchen settings", to: "/kitchen-settings" },
      { label: "Sign in", to: "/sign-in" },
    ]);
  });
});
