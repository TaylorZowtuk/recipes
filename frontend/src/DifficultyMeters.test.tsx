import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DifficultyMeters } from "./DifficultyMeters";

// Each meter's label and how many of its three pips are filled, then the Total.
function meters(markup: string) {
  return [...markup.matchAll(/<span class="meter">(.*?)<\/span><\/span>/g)].map(
    ([, inner = ""]) => [
      /<span class="meter-label">(.*?)<\/span>/.exec(inner)?.[1],
      (inner.match(/pip pip-on/g) ?? []).length,
    ],
  );
}

describe("DifficultyMeters", () => {
  it("shows a meter each for Prep, Cook and Cleanup, and the Total Difficulty", () => {
    const markup = renderToStaticMarkup(
      <DifficultyMeters difficulty={{ prep: 2, cook: 1, cleanup: 3 }} />,
    );
    expect(meters(markup)).toEqual([
      ["Prep", 2],
      ["Cook", 1],
      ["Cleanup", 3],
    ]);
    expect(markup.match(/class="pip[ "]/g)).toHaveLength(9);
    expect(markup).toContain('<span class="difficulty-total">Total 6/9</span>');
    expect(markup).toContain(
      'aria-label="Difficulty: Prep 2 of 3, Cook 1 of 3, Cleanup 3 of 3, total 6 of 9"',
    );
  });

  it("labels Suggested Difficulty as a suggestion, to the eye and to screen readers", () => {
    const markup = renderToStaticMarkup(
      <DifficultyMeters difficulty={{ prep: 2, cook: 1, cleanup: 3 }} suggested />,
    );
    expect(meters(markup)).toEqual([
      ["Prep", 2],
      ["Cook", 1],
      ["Cleanup", 3],
    ]);
    expect(markup).toContain('<span class="difficulty-suggested">Suggested</span>');
    expect(markup).toContain(
      'aria-label="Suggested difficulty: Prep 2 of 3, Cook 1 of 3, Cleanup 3 of 3, total 6 of 9"',
    );
  });

  it("doesn't label an editor's Difficulty as a suggestion", () => {
    const markup = renderToStaticMarkup(
      <DifficultyMeters difficulty={{ prep: 2, cook: 1, cleanup: 3 }} suggested={false} />,
    );
    expect(markup).not.toContain("uggested");
  });

  it("renders nothing for a recipe without a Difficulty", () => {
    expect(renderToStaticMarkup(<DifficultyMeters difficulty={null} />)).toBe("");
  });
});
