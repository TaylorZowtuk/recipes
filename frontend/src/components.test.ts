import { describe, expect, it } from "vitest";
import { byComponent } from "./components";

const line = (id: string, component: string | null) => ({ id, component, text: id });

describe("byComponent", () => {
  it("starts a new group wherever the component changes", () => {
    const groups = byComponent([
      line("i1", "For the sauce"),
      line("i2", "For the sauce"),
      line("i3", "For the tofu"),
      line("i4", null),
    ]);
    expect(groups.map((g) => [g.component, g.lines.map((l) => l.id)])).toEqual([
      ["For the sauce", ["i1", "i2"]],
      ["For the tofu", ["i3"]],
      [null, ["i4"]],
    ]);
  });

  it("numbers each group from where the previous one left off", () => {
    const groups = byComponent([line("s1", "A"), line("s2", "A"), line("s3", "B")]);
    expect(groups.map((g) => g.start)).toEqual([1, 3]);
  });

  it("keeps a recipe without components as one unnamed group", () => {
    expect(byComponent([line("i1", null), line("i2", null)])).toEqual([
      { component: null, start: 1, lines: [line("i1", null), line("i2", null)] },
    ]);
  });

  it("has no groups for no lines", () => {
    expect(byComponent([])).toEqual([]);
  });
});
