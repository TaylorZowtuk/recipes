import {
  type Dispatch,
  type FormEvent,
  type RefObject,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router";
import { api, type CountedSite, type CountedSites } from "./api/client";
import { reloadCollection, useCollection } from "./collection";
import { saveLabel } from "./editRecipe";
import {
  canMove,
  changeCount,
  type Draft,
  type DraftSite,
  draftOperations,
  editingSites,
  isComplete,
  recipeCountOf,
  type SitesAction,
  type SitesOutcome,
  sitesOutcome,
} from "./favoriteSites";
import { LoadFailed } from "./LoadFailed";
import { PAUSED, useEditBlock, useMounted } from "./RecipeFields";
import { focusTitle, Screen } from "./Screen";
import { EditorOnly } from "./session";

const EDIT_HEADING = "edit-sites-heading";

const recipeCount = (count: number) => (count === 1 ? "1 recipe" : `${count} recipes`);

// Off while offline or paused, like every edit that isn't queued.
function BlockedNote({ blocked }: { blocked: "offline" | "paused" | null }) {
  if (!blocked) return null;
  return (
    <p className="screen-note">
      {blocked === "offline"
        ? "You’re offline. Edit the Favorite Sites once you’re back online."
        : PAUSED}
    </p>
  );
}

// The Sites tab: the Favorite Sites in the household's order, and to an editor an Edit button that
// swaps the list for a Draft of it. One status note stays mounted through every state, so focus
// can rest on it after a retry.
export function FavoriteSitesScreen() {
  const collection = useCollection();
  const status = useRef<HTMLParagraphElement>(null);
  const [edit, dispatch] = useReducer(editingSites, { draft: null });
  const { draft } = edit;
  const saved = collection.state === "ready" ? collection.value.favorite_sites : undefined;

  // Focus moves with Edit, since the control that had it is gone: entering it, to the form's
  // heading; leaving it, to the notice saying why Edit closed if there is one, else the title.
  const notice = useRef<HTMLParagraphElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (!wasEditing.current && draft) focusEditHeading();
    if (wasEditing.current && !draft) {
      if (notice.current) notice.current.focus({ preventScroll: true });
      else focusTitle();
    }
    wasEditing.current = !!draft;
  }, [draft]);

  return (
    <Screen title="Favorite Sites">
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {collection.state === "loading" && "Loading the Favorite Sites…"}
      </p>
      {collection.state === "failed" && (
        <LoadFailed what="The Favorite Sites" retry={collection.retry} status={status} />
      )}
      {edit.notice && (
        <p ref={notice} role="alert" tabIndex={-1} className="screen-note">
          {edit.notice}
        </p>
      )}
      {saved && draft && (
        <SitesEditor saved={saved} draft={draft} problem={edit.problem} dispatch={dispatch} />
      )}
      {saved && !draft && (
        <SiteList
          sites={saved.sites}
          onEdit={() => dispatch({ type: "open", sites: saved.sites })}
        />
      )}
    </Screen>
  );
}

function SiteList({ sites, onEdit }: { sites: CountedSite[]; onEdit: () => void }) {
  const blocked = useEditBlock();
  return (
    <div className="sites">
      <EditorOnly>
        <div className="edit-open sites-edit-open">
          <button
            type="button"
            className="button button-secondary"
            disabled={!!blocked}
            onClick={onEdit}
          >
            Edit
          </button>
          <BlockedNote blocked={blocked} />
        </div>
      </EditorOnly>
      {sites.length === 0 && <p className="screen-note">No Favorite Sites yet.</p>}
      {sites.length > 0 && (
        <ul className="queued-list" aria-label="Favorite Sites">
          {sites.map((site) => (
            <li key={site.id}>
              <span className="queued-site">{site.name}</span>
              <a
                href={site.address}
                target="_blank"
                rel="noopener noreferrer"
                className="site-address"
              >
                {site.address}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
              {site.note && <p className="site-note">{site.note}</p>}
              <span className="queued-meta">{recipeCount(site.recipe_count)}</span>
              <EditorOnly>
                <AddFromSite site={site} disabled={!!blocked} />
              </EditorOnly>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Opens the site to browse for a recipe, and takes this tab to Add a recipe to paste its address
// into. The address itself is never offered to /add: a homepage isn't a recipe, and would leave a
// Queued Ingest that nothing can delete. The new tab opens first, in the click's own task, so
// popup blockers allow it; going to /add is a change within this page, which can't cancel it.
function AddFromSite({ site, disabled }: { site: CountedSite; disabled: boolean }) {
  const navigate = useNavigate();
  const add = () => {
    window.open(site.address, "_blank", "noopener,noreferrer");
    navigate("/add", { state: { fromSite: site.name } });
  };
  return (
    <button
      type="button"
      className="button button-secondary site-add"
      disabled={disabled}
      onClick={add}
    >
      Add a recipe from this site
      <span className="visually-hidden"> (opens {site.name} in a new tab)</span>
    </button>
  );
}

const focusEditHeading = () =>
  document.getElementById(EDIT_HEADING)?.focus({ preventScroll: true });

// Edit: the Draft of every site, saved together in one PATCH at the list's version. A conflict
// reloads the Collection and leaves Edit, showing the newer list.
function SitesEditor({
  saved,
  draft,
  problem,
  dispatch,
}: {
  saved: CountedSites;
  draft: Draft;
  problem?: string;
  dispatch: Dispatch<SitesAction>;
}) {
  const blocked = useEditBlock();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const count = changeCount(saved.sites, draft);

  // A new site's row starts at the foot of the list, so focus takes the editor there.
  const added = useRef(draft.addedSoFar);
  useEffect(() => {
    if (draft.addedSoFar > added.current) {
      document.getElementById(`site-name-added-${draft.addedSoFar - 1}`)?.focus();
    }
    added.current = draft.addedSoFar;
  }, [draft.addedSoFar]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || count === 0) return;
    if (!isComplete(draft)) return dispatch({ type: "incomplete" });
    setBusy(true);
    let outcome: SitesOutcome;
    try {
      outcome = sitesOutcome(
        await api.PATCH("/api/favorite-sites", {
          body: { version: saved.version, operations: draftOperations(saved.sites, draft) },
        }),
      );
    } catch {
      outcome = { kind: "failed" };
    }
    const refreshed =
      outcome.kind === "saved" || outcome.kind === "conflict" ? await reloadCollection() : true;
    if (!mounted.current) return;
    setBusy(false);
    dispatch({ type: "settled", outcome, refreshed });
  };

  return (
    <form
      className="review-form edit-form sites"
      aria-labelledby={EDIT_HEADING}
      noValidate
      onSubmit={save}
    >
      <h2 id={EDIT_HEADING} tabIndex={-1} className="visually-hidden">
        Edit Favorite Sites
      </h2>
      <fieldset disabled={!!blocked} className="review-fields">
        <ul className="queued-list">
          {draft.sites.map((site, index) => (
            <SiteRow
              key={site.key}
              site={site}
              count={recipeCountOf(saved.sites, site)}
              legend={saved.sites.find((s) => s.id === site.key)?.name ?? "New site"}
              canMoveUp={canMove(draft, index, -1)}
              canMoveDown={canMove(draft, index, 1)}
              dispatch={dispatch}
            />
          ))}
        </ul>
        <button
          type="button"
          className="button button-secondary site-add-new"
          onClick={() => dispatch({ type: "add" })}
        >
          Add a site
        </button>
      </fieldset>
      <div className="review-actions">
        <button
          type="submit"
          className="button"
          disabled={!!blocked || count === 0}
          aria-disabled={busy}
        >
          {busy ? "Saving…" : saveLabel(count)}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => dispatch({ type: "cancel" })}
        >
          Cancel
        </button>
      </div>
      <BlockedNote blocked={blocked} />
      <p role="status" className="screen-note">
        {busy ? "Saving the changes…" : ""}
      </p>
      {problem && (
        <p role="alert" className="form-problem">
          {problem}
        </p>
      )}
    </form>
  );
}

function SiteRow({
  site,
  count,
  legend,
  canMoveUp,
  canMoveDown,
  dispatch,
}: {
  site: DraftSite;
  count: number | undefined;
  legend: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dispatch: Dispatch<SitesAction>;
}) {
  const { key } = site;
  const change = (fields: Partial<DraftSite>) => dispatch({ type: "change", key, fields });
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);

  // Moving the row drops focus, and its button may now be off at the end of the list. So this
  // renders at once, then puts focus back on a move button that still works.
  const move = (by: -1 | 1, button: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => dispatch({ type: "move", key, by }));
    const other = button === up ? down : up;
    (button.current?.disabled ? other : button).current?.focus();
  };

  const remove = () => {
    dispatch({ type: "delete", key });
    focusEditHeading();
  };

  return (
    <li>
      <fieldset className="site-fields">
        <legend>{legend}</legend>
        {count !== undefined && <p className="queued-meta">{recipeCount(count)}</p>}
        <label htmlFor={`site-name-${key}`}>Name</label>
        <input
          id={`site-name-${key}`}
          className="text-input"
          autoComplete="off"
          maxLength={200}
          value={site.name}
          onChange={(event) => change({ name: event.target.value })}
        />
        <label htmlFor={`site-address-${key}`}>Address</label>
        <input
          id={`site-address-${key}`}
          className="text-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          value={site.address}
          onChange={(event) => change({ address: event.target.value })}
        />
        <label htmlFor={`site-note-${key}`}>Note</label>
        <textarea
          id={`site-note-${key}`}
          className="text-input site-note-input"
          rows={2}
          maxLength={500}
          value={site.note}
          onChange={(event) => change({ note: event.target.value })}
        />
        {site.added && <p className="field-hint">It can move once it’s saved.</p>}
        <div className="site-actions">
          <button
            ref={up}
            type="button"
            className="button button-secondary"
            disabled={!canMoveUp}
            onClick={() => move(-1, up)}
          >
            Move up
          </button>
          <button
            ref={down}
            type="button"
            className="button button-secondary"
            disabled={!canMoveDown}
            onClick={() => move(1, down)}
          >
            Move down
          </button>
          <button type="button" className="text-button text-button-danger" onClick={remove}>
            Delete
          </button>
        </div>
      </fieldset>
    </li>
  );
}
