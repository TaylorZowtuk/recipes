import { describe, expect, it } from "vitest";
import type { CountedSite, CountedSites } from "./api/client";
import {
  CHANGED_ELSEWHERE,
  CHANGED_NOT_REFRESHED,
  canMove,
  changeCount,
  type Draft,
  type DraftSite,
  draftOf,
  draftOperations,
  editingSites,
  INCOMPLETE,
  isComplete,
  recipeCountOf,
  type SitesAction,
  type SitesOutcome,
  sitesOutcome,
} from "./favoriteSites";

const site = (id: string, fields: Partial<CountedSite> = {}): CountedSite => ({
  id,
  name: `Site ${id}`,
  address: `https://${id}.example.com/`,
  note: "",
  recipe_count: 2,
  ...fields,
});
const SAVED = [site("a"), site("b"), site("c")];

// The Draft after these actions, from one opened on `SAVED`.
function draftAfter(...actions: SitesAction[]): Draft {
  return from(editingSites({ draft: null }, open()).draft as Draft, ...actions);
}
const from = (draft: Draft, ...actions: SitesAction[]) =>
  actions.reduce(editingSites, { draft }).draft as Draft;
const siteIn = (draft: Draft, key: string) => draft.sites.find((s) => s.key === key) as DraftSite;
const open = (): SitesAction => ({ type: "open", sites: SAVED });
const change = (key: string, fields: object): SitesAction => ({ type: "change", key, fields });
const add = (): SitesAction => ({ type: "add" });
const remove = (key: string): SitesAction => ({ type: "delete", key });
const move = (key: string, by: -1 | 1): SitesAction => ({ type: "move", key, by });
const count = (...actions: SitesAction[]) => changeCount(SAVED, draftAfter(...actions));

describe("changeCount", () => {
  it("is zero for an untouched Draft", () => {
    expect(count()).toBe(0);
  });

  it("counts each changed field of each site", () => {
    expect(
      count(change("a", { name: "New", note: "Good" }), change("b", { address: "https://x.y/" })),
    ).toBe(3);
  });

  it("drops a field reverted to its saved value", () => {
    expect(count(change("a", { name: "New" }), change("a", { name: "Site a" }))).toBe(0);
  });

  it("ignores spaces the API strips", () => {
    expect(count(change("a", { name: " Site a  " }))).toBe(0);
  });

  it("counts one per added site and one per deleted site", () => {
    expect(count(add(), add(), remove("a"))).toBe(3);
  });

  it("counts a reorder once however many moves it took", () => {
    expect(count(move("a", 1), move("a", 1), move("b", 1))).toBe(1);
  });

  it("drops a reorder moved back to the saved order", () => {
    expect(count(move("a", 1), move("a", -1))).toBe(0);
  });

  it("doesn't count a deleted site's field edits", () => {
    expect(count(change("a", { name: "New", note: "Good" }), remove("a"))).toBe(1);
  });

  it("doesn't count a delete as a reorder", () => {
    expect(count(remove("a"))).toBe(1);
  });

  it("counts nothing for a site added then deleted", () => {
    expect(count(add(), remove("added-0"))).toBe(0);
  });
});

describe("draftOperations", () => {
  it("sends field edits, then deletes, then one reorder, then adds", () => {
    const draft = draftAfter(
      add(),
      move("c", -1),
      remove("a"),
      change("b", { name: " New name " }),
      change("c", { address: " https://x.y/ ", note: "Good" }),
      change("added-0", { name: " Added ", address: " https://added.example.com ", note: " Hm " }),
    );
    expect(draftOperations(SAVED, draft)).toEqual([
      { op: "set_address", id: "c", address: "https://x.y/" },
      { op: "set_note", id: "c", note: "Good" },
      { op: "rename", id: "b", name: "New name" },
      { op: "delete", id: "a" },
      { op: "reorder", ids: ["c", "b"] },
      { op: "add", name: "Added", address: "https://added.example.com", note: "Hm" },
    ]);
  });

  it("clears a note with an empty one", () => {
    const saved = [site("a", { note: "Old" })];
    const draft = from(draftOf(saved), change("a", { note: "" }));
    expect(draftOperations(saved, draft)).toEqual([{ op: "set_note", id: "a", note: "" }]);
  });

  it("sends no reorder when deleting leaves the rest in order", () => {
    expect(draftOperations(SAVED, draftAfter(remove("b")))).toEqual([{ op: "delete", id: "b" }]);
  });

  it("sends nothing for a site added then deleted", () => {
    expect(draftOperations(SAVED, draftAfter(add(), remove("added-0")))).toEqual([]);
  });

  it("keeps added sites in the order they were added", () => {
    const draft = draftAfter(
      add(),
      add(),
      change("added-0", { name: "New 0", address: "https://new0.example.com/" }),
      change("added-1", { name: "New 1", address: "https://new1.example.com/" }),
    );
    expect(draftOperations(SAVED, draft).map((op) => op.op === "add" && op.name)).toEqual([
      "New 0",
      "New 1",
    ]);
  });

  it("gives an added site a key of its own after another was deleted", () => {
    const keys = draftAfter(add(), remove("added-0"), add()).sites.map((s) => s.key);
    expect(keys).toEqual(["a", "b", "c", "added-1"]);
  });
});

describe("moving", () => {
  it("swaps a site with its neighbour", () => {
    expect(draftAfter(move("a", 1)).sites.map((s) => s.key)).toEqual(["b", "a", "c"]);
  });

  it("stops at the top, and at the last saved site", () => {
    const draft = draftAfter(add());
    expect(canMove(draft, 0, -1)).toBe(false);
    expect(canMove(draft, 0, 1)).toBe(true);
    expect(canMove(draft, 2, -1)).toBe(true);
    expect(canMove(draft, 2, 1)).toBe(false);
  });

  it("never moves an added site, or a saved site below one", () => {
    const draft = draftAfter(add());
    expect(canMove(draft, 3, -1)).toBe(false);
    expect(canMove(draft, 3, 1)).toBe(false);
    expect(from(draft, move("added-0", -1))).toEqual(draft);
    expect(from(draft, move("c", 1))).toEqual(draft);
  });
});

describe("recipeCountOf", () => {
  it("is the saved count while the address stands", () => {
    const draft = draftAfter(change("a", { name: "New" }));
    expect(recipeCountOf(SAVED, siteIn(draft, "a"))).toBe(2);
  });

  it("is unknown once the address changes, and back when reverted", () => {
    const changed = draftAfter(change("a", { address: "https://x.y/" }));
    expect(recipeCountOf(SAVED, siteIn(changed, "a"))).toBeUndefined();
    const reverted = draftAfter(
      change("a", { address: "https://x.y/" }),
      change("a", { address: "https://a.example.com/" }),
    );
    expect(recipeCountOf(SAVED, siteIn(reverted, "a"))).toBe(2);
  });

  it("is unknown for an added site", () => {
    expect(recipeCountOf(SAVED, siteIn(draftAfter(add()), "added-0"))).toBeUndefined();
  });
});

describe("isComplete", () => {
  it("wants every site to have a name and a web address", () => {
    expect(isComplete(draftAfter())).toBe(true);
    expect(isComplete(draftAfter(change("a", { name: "  " })))).toBe(false);
    expect(isComplete(draftAfter(change("a", { address: "example.com" })))).toBe(false);
    expect(isComplete(draftAfter(add()))).toBe(false);
  });
});

const answer = (status: number, body: { data?: CountedSites; error?: unknown }) => ({
  ...body,
  response: new Response(null, { status }),
});

describe("sitesOutcome", () => {
  it("is saved on a 200", () => {
    expect(sitesOutcome(answer(200, { data: { version: 2, sites: [] } })).kind).toBe("saved");
  });

  it("is a conflict on the API's 409", () => {
    expect(sitesOutcome(answer(409, { error: { detail: "stale" } })).kind).toBe("conflict");
  });

  it("is not-an-editor on the API's 403, and failed on the WAF's", () => {
    expect(sitesOutcome(answer(403, { error: { detail: "no" } })).kind).toBe("not-an-editor");
    expect(sitesOutcome(answer(403, { error: "<html>" })).kind).toBe("failed");
  });

  it("carries the server's message on a 422", () => {
    expect(
      sitesOutcome(answer(422, { error: { detail: "Two sites are on the same host" } })),
    ).toEqual({
      kind: "invalid",
      message: "Two sites are on the same host",
    });
  });

  it("carries the first message of a validation 422", () => {
    expect(
      sitesOutcome(answer(422, { error: { detail: [{ msg: "Too long" }, { msg: "Other" }] } })),
    ).toEqual({ kind: "invalid", message: "Too long" });
  });

  it("is failed on a 422 with no message", () => {
    expect(sitesOutcome(answer(422, { error: "<html>" })).kind).toBe("failed");
  });
});

describe("editingSites", () => {
  const editing = () => ({ draft: draftAfter(change("a", { name: "New" })) });
  const settled = (outcome: SitesOutcome, refreshed = true) =>
    editingSites(editing(), { type: "settled", outcome, refreshed });

  it("opens from the saved sites, dropping any old notice", () => {
    const state = editingSites({ draft: null, notice: "Old" }, open());
    expect(state).toEqual({ draft: draftOf(SAVED) });
  });

  it("discards the Draft on Cancel", () => {
    expect(editingSites(editing(), { type: "cancel" })).toEqual({ draft: null });
  });

  it("says what's missing, keeping the Draft", () => {
    const state = editingSites(editing(), { type: "incomplete" });
    expect(state.problem).toBe(INCOMPLETE);
    expect(state.draft).toEqual(editing().draft);
  });

  it("closes on a save", () => {
    expect(settled({ kind: "saved" })).toEqual({ draft: null });
  });

  it("closes and says so when a save couldn't refresh", () => {
    const state = settled({ kind: "saved" }, false);
    expect(state.draft).toBeNull();
    expect(state.notice).toMatch(/Saved, but couldn’t refresh/);
  });

  it("drops the Draft on a conflict and shows the notice", () => {
    expect(settled({ kind: "conflict" })).toEqual({ draft: null, notice: CHANGED_ELSEWHERE });
    expect(settled({ kind: "conflict" }, false)).toEqual({
      draft: null,
      notice: CHANGED_NOT_REFRESHED,
    });
  });

  it("keeps the Draft and shows the server's message on a 422", () => {
    const state = settled({ kind: "invalid", message: "Two sites are on the same host" });
    expect(state.draft).toEqual(editing().draft);
    expect(state.problem).toBe("Two sites are on the same host");
  });

  it("keeps the Draft on any other failure", () => {
    expect(settled({ kind: "failed" }).draft).toEqual(editing().draft);
    expect(settled({ kind: "failed" }).problem).toMatch(/Couldn’t reach/);
    expect(settled({ kind: "not-an-editor" }).problem).toMatch(/Sign in again/);
  });
});
