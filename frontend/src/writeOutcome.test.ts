import { describe, expect, it } from "vitest";
import type { Sync } from "./api/client";
import { batchOutcome, editBlock } from "./writeOutcome";

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

const answer = (status: number, body: { data?: object; error?: unknown }) => ({
  ...body,
  response: new Response(null, { status }),
});

describe("batchOutcome", () => {
  it("is saved on a 200", () => {
    expect(batchOutcome(answer(200, { data: { version: 2, sites: [] } })).kind).toBe("saved");
  });

  it("is a conflict on the API's 409", () => {
    expect(batchOutcome(answer(409, { error: { detail: "stale" } })).kind).toBe("conflict");
  });

  it("is not-an-editor on the API's 403, and failed on the WAF's", () => {
    expect(batchOutcome(answer(403, { error: { detail: "no" } })).kind).toBe("not-an-editor");
    expect(batchOutcome(answer(403, { error: "<html>" })).kind).toBe("failed");
  });

  it("carries the server's message on a 422", () => {
    expect(
      batchOutcome(answer(422, { error: { detail: "Two sites are on the same host" } })),
    ).toEqual({
      kind: "invalid",
      message: "Two sites are on the same host",
    });
  });

  it("carries the first message of a validation 422", () => {
    expect(
      batchOutcome(answer(422, { error: { detail: [{ msg: "Too long" }, { msg: "Other" }] } })),
    ).toEqual({ kind: "invalid", message: "Too long" });
  });

  it("is failed on a 422 with no message", () => {
    expect(batchOutcome(answer(422, { error: "<html>" })).kind).toBe("failed");
  });
});
