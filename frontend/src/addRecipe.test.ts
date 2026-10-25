import { describe, expect, it } from "vitest";
import {
  type Candidate,
  chosenDifficulty,
  defaultPreview,
  editBlock,
  ingestOutcome,
  parseTags,
  photoFields,
  saveOutcome,
  stillStoring,
  storedImages,
} from "./addRecipe";
import type { Duplicate, Image, Ingested, QueuedIngest, Sync } from "./api/client";

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

  it("is a retry when a 409 names neither a recipe nor a Queued Ingest", () => {
    const neither = { detail: "Try again", recipe_id: null, queued_ingest_id: null };
    expect(ingestOutcome({ error: neither, response: response(409) })).toEqual({
      kind: "conflict",
    });
  });

  it("tells a missing page from an invalid URL and from anything else", () => {
    expect(ingestOutcome({ response: response(404) })).toEqual({ kind: "not-found" });
    expect(ingestOutcome({ response: response(422) })).toEqual({ kind: "invalid" });
    expect(ingestOutcome({ response: response(503) })).toEqual({ kind: "failed" });
  });

  it("is not-an-editor only for the API's own 403", () => {
    const refused = { detail: "Not an editor" };
    expect(ingestOutcome({ error: refused, response: response(403) })).toEqual({
      kind: "not-an-editor",
    });
    // The WAF's rate-limit block is a 403 with no JSON detail.
    expect(ingestOutcome({ error: "<html>Forbidden</html>", response: response(403) })).toEqual({
      kind: "failed",
    });
    expect(ingestOutcome({ response: response(403) })).toEqual({ kind: "failed" });
  });
});

describe("saveOutcome", () => {
  it("is saved on a 201", () => {
    expect(saveOutcome({ response: response(201) })).toEqual({ kind: "saved" });
  });

  it("names a duplicate, or is a retry when the 409 names nothing", () => {
    expect(saveOutcome({ error: duplicate, response: response(409) })).toEqual({
      kind: "duplicate",
      duplicate,
    });
    const neither = { detail: "Try again", recipe_id: null, queued_ingest_id: null };
    expect(saveOutcome({ error: neither, response: response(409) })).toEqual({ kind: "conflict" });
  });

  it("is not-an-editor only for the API's own 403, and anything else a failure", () => {
    expect(saveOutcome({ error: { detail: "Not an editor" }, response: response(403) })).toEqual({
      kind: "not-an-editor",
    });
    expect(saveOutcome({ error: "Forbidden", response: response(403) })).toEqual({
      kind: "failed",
    });
    expect(saveOutcome({ response: response(422) })).toEqual({ kind: "failed" });
  });
});

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

const image = (id: string): Image => ({
  id,
  width: 1200,
  height: 800,
  origin: `https://plateful.test/photos/${id}.png`,
});
const candidates: Candidate[] = [
  { url: "https://plateful.test/photos/a.png", state: "unavailable" },
  { url: "https://plateful.test/photos/b.png", state: "storing" },
  { url: "https://plateful.test/photos/c.png", state: "stored", image: image("c") },
  { url: "https://plateful.test/photos/d.png", state: "stored", image: image("d") },
];

describe("defaultPreview", () => {
  it("is the first stored Candidate Photo, centred", () => {
    expect(defaultPreview(candidates)).toEqual({ image_id: "c", focal_x: 0.5, focal_y: 0.5 });
  });

  it("is no photo while none has stored", () => {
    expect(defaultPreview(candidates.slice(0, 2))).toBeNull();
  });
});

describe("storedImages", () => {
  it("keeps the same photo once, though two candidates found it", () => {
    const again: Candidate = {
      url: "https://plateful.test/c-again.png",
      state: "stored",
      image: image("c"),
    };
    expect(storedImages([...candidates, again])).toEqual([image("c"), image("d")]);
  });
});

describe("stillStoring", () => {
  it("counts the Candidate Photos not yet stored or unavailable", () => {
    expect(stillStoring(candidates)).toBe(1);
  });

  it("is none once every candidate has settled", () => {
    expect(stillStoring(candidates.filter((c) => c.state !== "storing"))).toBe(0);
  });
});

describe("photoFields", () => {
  it("keeps every stored Candidate Photo beside the Preview Photo", () => {
    const preview = { image_id: "d", focal_x: 0.2, focal_y: 0.7 };
    expect(photoFields(candidates, preview)).toEqual({
      images: [image("c"), image("d")],
      preview,
    });
  });

  it("is a null preview for no photo, still keeping the candidates", () => {
    expect(photoFields(candidates, null)).toEqual({
      images: [image("c"), image("d")],
      preview: null,
    });
  });
});
