import type { CountedSite, SiteOperation } from "./api/client";
import { SAVED_NOT_REFRESHED, UNREACHABLE } from "./editRecipe";
import type { BatchOutcome } from "./writeOutcome";

type SiteFields = Pick<CountedSite, "name" | "address" | "note">;

// A site in a Draft. A saved site's key is its id; a site added in the Draft isn't saved yet.
export type DraftSite = SiteFields & { key: string; added?: boolean };

// An editor's Draft of the Favorite Sites, in the order Edit shows them: the saved sites still in
// the list, then the added ones. It lives only in the Sites tab's state, so Cancel or leaving the
// page discards it. `addedSoFar` keeps each added site's key its own.
export type Draft = { sites: DraftSite[]; addedSoFar: number };

export const INCOMPLETE = "Each site needs a name and an address that starts with https://.";
export const CHANGED_ELSEWHERE =
  "The Favorite Sites changed on another device. Showing the newer version.";
export const CHANGED_NOT_REFRESHED =
  "The Favorite Sites changed on another device, but couldn’t refresh. Reload to see the newer version.";
const NOT_AN_EDITOR = "Only the household’s editors can edit Favorite Sites. Sign in again.";

export function draftOf(sites: CountedSite[]): Draft {
  return {
    sites: sites.map(({ id, name, address, note }) => ({ key: id, name, address, note })),
    addedSoFar: 0,
  };
}

// The API strips a name and a note, and an address with spaces around it isn't one.
const trimmed = ({ name, address, note }: SiteFields): SiteFields => ({
  name: name.trim(),
  address: address.trim(),
  note: note.trim(),
});

// The PATCH operations for what the draft changes, in the order the API applies them: field edits,
// deletes, one reorder of the surviving saved sites if their order changed, then adds. A saved
// site is deleted by leaving the draft, so its field edits go with it and each operation is one
// change.
export function draftOperations(saved: CountedSite[], draft: Draft): SiteOperation[] {
  const kept = draft.sites.filter((site) => !site.added);
  const keptIds = kept.map((site) => site.key);
  const fields = kept.flatMap(({ key: id, ...site }): SiteOperation[] => {
    const before = saved.find((s) => s.id === id);
    const { name, address, note } = trimmed(site);
    return [
      ...(name !== before?.name ? [{ op: "rename" as const, id, name }] : []),
      ...(address !== before?.address ? [{ op: "set_address" as const, id, address }] : []),
      ...(note !== before?.note ? [{ op: "set_note" as const, id, note }] : []),
    ];
  });
  const survivors = saved.map((s) => s.id).filter((id) => keptIds.includes(id));
  return [
    ...fields,
    ...saved
      .filter((s) => !keptIds.includes(s.id))
      .map(({ id }): SiteOperation => ({ op: "delete", id })),
    ...(survivors.some((id, i) => id !== keptIds[i])
      ? [{ op: "reorder" as const, ids: keptIds }]
      : []),
    ...draft.sites
      .filter((site) => site.added)
      .map((site): SiteOperation => ({ op: "add", ...trimmed(site) })),
  ];
}

export const changeCount = (saved: CountedSite[], draft: Draft) =>
  draftOperations(saved, draft).length;

// Whether the site at `index` can swap with its neighbour. An added site has no place among the
// saved ones until it's saved: it can't move, and a saved site can't move below it.
export function canMove({ sites }: Draft, index: number, by: -1 | 1) {
  const site = sites[index];
  const neighbour = sites[index + by];
  return !!site && !!neighbour && !site.added && !neighbour.added;
}

// A site's recipe count as Edit shows it. It's undefined for an added site or a changed address,
// since only saving tells which cards are on that host.
export function recipeCountOf(saved: CountedSite[], site: DraftSite): number | undefined {
  const before = saved.find((s) => s.id === site.key);
  return before?.address === site.address.trim() ? before.recipe_count : undefined;
}

// Whether the API could take the draft's sites, so the commonest mistakes need no round trip and
// read as a sentence, not as the API's validation message.
export const isComplete = ({ sites }: Draft) =>
  sites.every(({ name, address }) => name.trim() && /^https?:\/\/\S+$/i.test(address.trim()));

// Edit on the Sites tab: a draft while editing, null while read-only. A conflict discards the
// draft, since the newer list shows instead and nothing is merged; any other failure keeps it.
// `refreshed` says whether the Collection reloaded after the write.
type SitesState = { draft: Draft | null; problem?: string; notice?: string };

export type SitesAction =
  | { type: "open"; sites: CountedSite[] }
  | { type: "change"; key: string; fields: Partial<SiteFields> }
  | { type: "move"; key: string; by: -1 | 1 }
  | { type: "delete"; key: string }
  | { type: "add" }
  | { type: "cancel" }
  | { type: "incomplete" }
  | { type: "settled"; outcome: BatchOutcome; refreshed: boolean };

function edited(draft: Draft, action: SitesAction): Draft {
  const { sites, addedSoFar } = draft;
  switch (action.type) {
    case "change":
      return {
        ...draft,
        sites: sites.map((s) => (s.key === action.key ? { ...s, ...action.fields } : s)),
      };
    case "move": {
      const index = sites.findIndex((s) => s.key === action.key);
      const site = sites[index];
      if (!site || !canMove(draft, index, action.by)) return draft;
      const moved = sites.filter((s) => s !== site);
      moved.splice(index + action.by, 0, site);
      return { ...draft, sites: moved };
    }
    case "delete":
      return { ...draft, sites: sites.filter((s) => s.key !== action.key) };
    case "add":
      return {
        sites: [
          ...sites,
          { key: `added-${addedSoFar}`, name: "", address: "", note: "", added: true },
        ],
        addedSoFar: addedSoFar + 1,
      };
    default:
      return draft;
  }
}

export function editingSites(state: SitesState, action: SitesAction): SitesState {
  switch (action.type) {
    case "open":
      return { draft: draftOf(action.sites) };
    case "cancel":
      return { draft: null };
    case "incomplete":
      return { ...state, problem: INCOMPLETE };
    case "settled":
      switch (action.outcome.kind) {
        case "saved":
          return action.refreshed ? { draft: null } : { draft: null, notice: SAVED_NOT_REFRESHED };
        case "conflict":
          return {
            draft: null,
            notice: action.refreshed ? CHANGED_ELSEWHERE : CHANGED_NOT_REFRESHED,
          };
        case "invalid":
          return { ...state, problem: action.outcome.message };
        case "not-an-editor":
          return { ...state, problem: NOT_AN_EDITOR };
        default:
          return { ...state, problem: UNREACHABLE };
      }
    default:
      return state.draft ? { ...state, draft: edited(state.draft, action) } : state;
  }
}
