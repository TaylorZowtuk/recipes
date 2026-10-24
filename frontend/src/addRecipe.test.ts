import { describe, expect, it } from "vitest";
import { chosenDifficulty, ingestOutcome, parseTags } from "./addRecipe";
import type { Duplicate, Ingested, QueuedIngest } from "./api/client";

const ingested = { source: { url: "https://plateful.test/a" } } as Ingested;
const queuedIngest = { id: "01Q", state: "waiting" } as QueuedIngest;
const duplicate: Duplicate = {
  detail: "Already a recipe",
  recipe_id: "01R",
  queued_ingest_id: null,
};
const response = (status: number) => new Response(null, { status });

describe("ingestOutcome", () => {
  it("is the captured Original on a 200, to review", () => {
    expect(ingestOutcome({ data: ingested, response: response(200) })).toEqual({
      kind: "ingested",
      ingested,
    });
  });

  it("is a Queued Ingest on a 202", () => {
    expect(ingestOutcome({ data: queuedIngest, response: response(202) })).toEqual({
      kind: "queued",
      queuedIngest,
    });
  });

  it("names what a duplicate points at", () => {
    expect(ingestOutcome({ error: duplicate, response: response(409) })).toEqual({
      kind: "duplicate",
      duplicate,
    });
  });

  it("tells a missing page from an invalid URL and from anything else", () => {
    expect(ingestOutcome({ response: response(404) })).toEqual({ kind: "not-found" });
    expect(ingestOutcome({ response: response(422) })).toEqual({ kind: "invalid" });
    expect(ingestOutcome({ response: response(403) })).toEqual({ kind: "not-an-editor" });
    expect(ingestOutcome({ response: response(503) })).toEqual({ kind: "failed" });
  });
});

describe("parseTags", () => {
  it("splits on commas and trims each tag", () => {
    expect(parseTags(" weeknight, vegetarian ,quick ")).toEqual([
      "weeknight",
      "vegetarian",
      "quick",
    ]);
  });

  it("drops empty tags and repeats, whatever their case", () => {
    expect(parseTags("Quick,, quick ,QUICK, ,soup")).toEqual(["Quick", "soup"]);
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("chosenDifficulty", () => {
  it("is no Difficulty when none is rated", () => {
    expect(chosenDifficulty({})).toEqual({ complete: true, difficulty: null });
  });

  it("is the Difficulty once all three are rated", () => {
    expect(chosenDifficulty({ prep: 1, cook: 3, cleanup: 2 })).toEqual({
      complete: true,
      difficulty: { prep: 1, cook: 3, cleanup: 2 },
    });
  });

  it("is incomplete with only some rated", () => {
    expect(chosenDifficulty({ prep: 2 })).toEqual({ complete: false });
    expect(chosenDifficulty({ prep: 2, cleanup: 1 })).toEqual({ complete: false });
  });
});
