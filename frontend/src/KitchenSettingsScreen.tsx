import {
  type CSSProperties,
  type Dispatch,
  type DOMAttributes,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { api, type CanonicalIngredient, type KitchenSettings } from "./api/client";
import { reloadCollection, useCollection } from "./collection";
import { saveLabel } from "./editRecipe";
import { GripIcon, SearchIcon } from "./icons";
import {
  type CategoriesAction,
  canDrag,
  canMove,
  changeCount,
  type Draft,
  type DraftCategory,
  type DragShift,
  draftOperations,
  draftProblem,
  dragOffset,
  dropIndex,
  editingCategories,
  ingredientsMoving,
  moveTargets,
  stapleNotice,
} from "./kitchenSettings";
import { LoadFailed } from "./LoadFailed";
import { PAUSED, useEditBlock, useMounted } from "./RecipeFields";
import { focusTitle, Screen } from "./Screen";
import { Sheet } from "./Sheet";
import { EditorOnly } from "./session";
import { Toast, type ToastMessage } from "./Toast";
import { alphabetical, titleMatches } from "./titleSearch";
import { type BatchOutcome, batchOutcome, versionedRefusal } from "./writeOutcome";

const EDIT_HEADING = "edit-categories-heading";
const NEW_CATEGORY = "New category";
// How near the window's edges a drag scrolls it, and how far each pointer move does.
const DRAG_EDGE = 96;
const DRAG_SCROLL = 16;

const focusEditHeading = () =>
  document.getElementById(EDIT_HEADING)?.focus({ preventScroll: true });

// Off while offline or paused, like every edit that isn't queued.
function BlockedNote({ blocked }: { blocked: "offline" | "paused" | null }) {
  if (!blocked) return null;
  return (
    <p className="screen-note">
      {blocked === "offline"
        ? "You’re offline. Change the Kitchen settings once you’re back online."
        : PAUSED}
    </p>
  );
}

// Kitchen settings: the Store Categories in the household's order, which an editor changes through
// a Draft, and every Canonical Ingredient with its Pantry Staple toggle, which saves at once. The
// Draft lives here and in its own `base`, so a toggle's Collection reload leaves it alone.
export function KitchenSettingsScreen() {
  const collection = useCollection();
  const status = useRef<HTMLParagraphElement>(null);
  const [edit, dispatch] = useReducer(editingCategories, { draft: null });
  const { draft } = edit;
  const loaded = collection.state === "ready" ? collection.value : undefined;

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
    <Screen title="Kitchen settings" pushed>
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {collection.state === "loading" && "Loading the Kitchen settings…"}
      </p>
      {collection.state === "failed" && (
        <LoadFailed what="The Kitchen settings" retry={collection.retry} status={status} />
      )}
      {loaded && (
        <div className="kitchen">
          <section aria-labelledby="store-categories-heading">
            <h2 id="store-categories-heading">Store Categories</h2>
            {edit.notice && (
              <p ref={notice} role="alert" tabIndex={-1} className="screen-note">
                {edit.notice}
              </p>
            )}
            {draft ? (
              <CategoriesEditor
                draft={draft}
                ingredients={loaded.canonical_ingredients}
                problem={edit.problem}
                dispatch={dispatch}
              />
            ) : (
              <CategoryList
                settings={loaded.kitchen_settings}
                onEdit={() => dispatch({ type: "open", settings: loaded.kitchen_settings })}
              />
            )}
          </section>
          <PantryStaples
            ingredients={loaded.canonical_ingredients}
            settings={loaded.kitchen_settings}
          />
        </div>
      )}
    </Screen>
  );
}

function CategoryList({ settings, onEdit }: { settings: KitchenSettings; onEdit: () => void }) {
  const blocked = useEditBlock();
  return (
    <>
      <EditorOnly>
        <div className="edit-open kitchen-edit-open">
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
      <ol className="queued-list" aria-label="Store Categories">
        {settings.store_categories.map(({ id, name }) => (
          <li key={id}>
            <span className="queued-site">{name}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

type Grip = Pick<
  DOMAttributes<HTMLButtonElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
>;
type Drag = DragShift & { key: string; startY: number; count: number };

// A pointer drag on a row's grip, for touch and mouse alike. The rows stay where they are in the
// page while it lasts, drawn shifted, and the Draft changes once, on the drop: moving a row's
// element mid-drag would drop the grip's pointer capture.
function useCategoryDrag(draft: Draft, dispatch: Dispatch<CategoriesAction>) {
  const rows = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const grip = (key: string): Grip => ({
    onPointerDown(event) {
      if (event.currentTarget.matches(":disabled")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const saved = draft.categories.filter((category) => !category.added);
      const [first, second] = [...(rows.current?.children ?? [])].map((row) =>
        row.getBoundingClientRect(),
      );
      const from = saved.findIndex((category) => category.key === key);
      setDrag({
        key,
        from,
        to: from,
        dy: 0,
        startY: event.pageY,
        stride: (second?.top ?? 0) - (first?.top ?? 0),
        count: saved.length,
      });
    },
    onPointerMove(event) {
      if (drag?.key !== key) return;
      // The list can be taller than a phone's screen, and the grip holds off the page's own scroll.
      if (event.clientY < DRAG_EDGE) window.scrollBy(0, -DRAG_SCROLL);
      if (event.clientY > window.innerHeight - DRAG_EDGE) window.scrollBy(0, DRAG_SCROLL);
      const dy = event.pageY - drag.startY;
      setDrag({ ...drag, dy, to: dropIndex(drag.from, dy, drag.stride, drag.count) });
    },
    onPointerUp() {
      if (drag?.key !== key) return;
      dispatch({ type: "place", key, index: drag.to });
      setDrag(null);
    },
    onPointerCancel() {
      setDrag(null);
    },
  });

  return { rows, drag, grip };
}

const savedName = ({ base }: Draft, key: string) =>
  base.store_categories.find((category) => category.id === key)?.name ?? NEW_CATEGORY;

// A row's name in the delete sheet: as the Draft has it, else as saved.
const rowName = (draft: Draft, { key, name }: DraftCategory) =>
  name.trim() || savedName(draft, key);

// Edit: the Draft of every Store Category, saved together in one PATCH at the version it opened on.
// A conflict reloads the Collection and leaves Edit, showing the newer list.
function CategoriesEditor({
  draft,
  ingredients,
  problem,
  dispatch,
}: {
  draft: Draft;
  ingredients: CanonicalIngredient[];
  problem?: string;
  dispatch: Dispatch<CategoriesAction>;
}) {
  const blocked = useEditBlock();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<DraftCategory | null>(null);
  const { rows, drag, grip } = useCategoryDrag(draft, dispatch);
  const count = changeCount(draft);

  // A new category's row starts at the foot of the list, so focus takes the editor there.
  const added = useRef(draft.addedSoFar);
  useEffect(() => {
    if (draft.addedSoFar > added.current) {
      document.getElementById(`category-name-added-${draft.addedSoFar - 1}`)?.focus();
    }
    added.current = draft.addedSoFar;
  }, [draft.addedSoFar]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || count === 0) return;
    const found = draftProblem(draft);
    if (found) return dispatch({ type: "problem", problem: found });
    setBusy(true);
    let outcome: BatchOutcome;
    try {
      outcome = batchOutcome(
        await api.PATCH("/api/kitchen-settings", {
          body: { version: draft.base.version, operations: draftOperations(draft) },
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

  // A category added in this Draft has nothing to move, so it goes at once.
  const remove = (category: DraftCategory) => {
    if (!category.added) return setDeleting(category);
    dispatch({ type: "delete", key: category.key });
    focusEditHeading();
  };

  return (
    <>
      <form
        className="review-form edit-form"
        aria-labelledby={EDIT_HEADING}
        noValidate
        onSubmit={save}
      >
        <h3 id={EDIT_HEADING} tabIndex={-1} className="visually-hidden">
          Edit Store Categories
        </h3>
        <fieldset disabled={!!blocked} className="review-fields">
          <ul ref={rows} className={`queued-list category-rows${drag ? " is-dragging" : ""}`}>
            {draft.categories.map((category, index) => (
              <CategoryRow
                key={category.key}
                category={category}
                label={savedName(draft, category.key)}
                canMoveUp={canMove(draft, index, -1)}
                canMoveDown={canMove(draft, index, 1)}
                canDelete={!!category.added || moveTargets(draft, category.key).length > 0}
                canDrag={canDrag(draft, category.key)}
                dragged={drag?.key === category.key}
                offset={drag ? dragOffset(drag, index) : 0}
                onDelete={() => remove(category)}
                onGrip={grip(category.key)}
                dispatch={dispatch}
              />
            ))}
          </ul>
          <button
            type="button"
            className="button button-secondary site-add-new"
            onClick={() => dispatch({ type: "add" })}
          >
            Add a category
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
      <DeleteSheet
        category={deleting}
        draft={draft}
        ingredients={ingredients}
        dispatch={dispatch}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

export function CategoryRow({
  category,
  label,
  canMoveUp,
  canMoveDown,
  canDelete,
  canDrag,
  dragged = false,
  offset = 0,
  onDelete,
  onGrip,
  dispatch,
}: {
  category: DraftCategory;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canDelete: boolean;
  canDrag: boolean;
  dragged?: boolean;
  offset?: number;
  onDelete: () => void;
  onGrip: Grip;
  dispatch: Dispatch<CategoriesAction>;
}) {
  const { key } = category;
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const name = <span className="visually-hidden"> {category.name.trim() || label}</span>;
  const shifted: CSSProperties | undefined = offset
    ? { transform: `translateY(${offset}px)` }
    : undefined;

  // Moving the row drops focus, and its button may now be off at the end of the list. So this
  // renders at once, then puts focus back on a move button that still works.
  const move = (by: -1 | 1, button: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => dispatch({ type: "move", key, by }));
    const other = button === up ? down : up;
    (button.current?.disabled ? other : button).current?.focus();
  };

  return (
    <li className={dragged ? "is-dragged" : undefined} style={shifted}>
      <div className="category-name">
        {/* For the pointer only: a keyboard or screen reader has Move up and Move down. */}
        <button
          type="button"
          className="category-grip"
          tabIndex={-1}
          aria-hidden="true"
          disabled={!canDrag}
          {...onGrip}
        >
          <GripIcon />
        </button>
        <input
          id={`category-name-${key}`}
          className="text-input"
          aria-label={`Name of ${label}`}
          autoComplete="off"
          maxLength={200}
          value={category.name}
          onChange={(event) => dispatch({ type: "change", key, name: event.target.value })}
        />
      </div>
      {category.added && <p className="field-hint">It can move once it’s saved.</p>}
      <div className="site-actions">
        <button
          ref={up}
          type="button"
          className="button button-secondary"
          disabled={!canMoveUp}
          onClick={() => move(-1, up)}
        >
          Move up
          {name}
        </button>
        <button
          ref={down}
          type="button"
          className="button button-secondary"
          disabled={!canMoveDown}
          onClick={() => move(1, down)}
        >
          Move down
          {name}
        </button>
        <button
          id={`category-delete-${key}`}
          type="button"
          className="text-button text-button-danger"
          disabled={!canDelete}
          onClick={onDelete}
        >
          Delete
          {name}
        </button>
      </div>
      {!canDelete && <p className="field-hint">The last saved Store Category can’t be deleted.</p>}
    </li>
  );
}

const ingredientCount = (count: number) => {
  if (count === 0) return "No Canonical Ingredients will move.";
  return count === 1
    ? "1 Canonical Ingredient will move."
    : `${count} Canonical Ingredients will move.`;
};

// Asks where a saved category's Canonical Ingredients move. The API needs a target even when none
// would move, so Delete waits for a choice. Focus goes back to the row's Delete if the row stays.
function DeleteSheet({
  category,
  draft,
  ingredients,
  dispatch,
  onClose,
}: {
  category: DraftCategory | null;
  draft: Draft;
  ingredients: CanonicalIngredient[];
  dispatch: Dispatch<CategoriesAction>;
  onClose: () => void;
}) {
  const blocked = useEditBlock();
  const group = useId();
  const [target, setTarget] = useState<string | null>(null);
  // The sheet tells of its closing after `category` has gone.
  const asked = useRef("");
  if (category) asked.current = category.key;
  const close = () => {
    setTarget(null);
    onClose();
    const row = document.getElementById(`category-delete-${asked.current}`);
    if (row) row.focus();
    else focusEditHeading();
  };
  return (
    <Sheet
      open={!!category}
      title={category ? `Delete ${rowName(draft, category)}` : ""}
      onClose={close}
    >
      {category && (
        <>
          <p className="sheet-lead">
            {ingredientCount(ingredientsMoving(ingredients, draft, category.key))}
          </p>
          <fieldset className="sheet-section">
            <legend>Move to</legend>
            <div className="choices">
              {moveTargets(draft, category.key).map((option) => (
                <label key={option.key} className="choice">
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={group}
                    checked={target === option.key}
                    onChange={() => setTarget(option.key)}
                  />
                  <span className="choice-text">{rowName(draft, option)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="sheet-actions">
            <button
              type="button"
              className="button"
              disabled={!target || !!blocked}
              onClick={() => {
                dispatch({ type: "delete", key: category.key, moveTo: target ?? undefined });
                onClose();
              }}
            >
              Delete
            </button>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// Every Canonical Ingredient, confirmed or not, with its Store Category. An editor's toggle saves
// that one row at once, whether or not a Draft is open. It stays pending through the reload, since
// a second write before then would go at the version the first one replaced.
function PantryStaples({
  ingredients,
  settings,
}: {
  ingredients: CanonicalIngredient[];
  settings: KitchenSettings;
}) {
  const blocked = useEditBlock();
  const mounted = useMounted();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const dismiss = useCallback(() => setToast(null), []);
  const sorted = useMemo(
    () => [...ingredients].sort((a, b) => alphabetical(a.name, b.name)),
    [ingredients],
  );
  const shown = sorted.filter(({ name }) => titleMatches(name, query));
  const q = query.trim();

  const toggle = async ({ id, version, pantry_staple }: CanonicalIngredient) => {
    if (pending.has(id)) return;
    setPending((ids) => new Set(ids).add(id));
    setToast(null);
    let outcome: Parameters<typeof stapleNotice>[0];
    try {
      const answer = await api.PATCH("/api/canonical-ingredients/{canonical_id}", {
        params: { path: { canonical_id: id } },
        body: {
          version,
          operations: [{ op: "set_pantry_staple", pantry_staple: !pantry_staple }],
        },
      });
      outcome = answer.data ? { kind: "saved" } : versionedRefusal(answer);
    } catch {
      outcome = { kind: "failed" };
    }
    const refreshed =
      outcome.kind === "saved" || outcome.kind === "conflict" ? await reloadCollection() : true;
    if (!mounted.current) return;
    setPending((ids) => new Set([...ids].filter((other) => other !== id)));
    const text = stapleNotice(outcome, refreshed);
    if (text) setToast({ text });
  };

  return (
    <section aria-labelledby="pantry-staples-heading">
      <h2 id="pantry-staples-heading">Pantry Staples</h2>
      {ingredients.length === 0 && <p className="screen-note">No Canonical Ingredients yet.</p>}
      {ingredients.length > 0 && (
        <>
          <search className="search">
            <SearchIcon />
            <input
              type="search"
              aria-label="Search Canonical Ingredients"
              placeholder="Search ingredients"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </search>
          <EditorOnly>
            <BlockedNote blocked={blocked} />
          </EditorOnly>
          <p role="status" className="screen-note">
            {shown.length === 0 && `No Canonical Ingredients match “${q}”.`}
          </p>
        </>
      )}
      {shown.length > 0 && (
        <ul className="queued-list staple-rows" aria-label="Canonical Ingredients">
          {shown.map((ingredient) => {
            const busy = pending.has(ingredient.id);
            const category = settings.store_categories.find(
              ({ id }) => id === ingredient.store_category_id,
            );
            return (
              <li key={ingredient.id}>
                <div className="staple-name">
                  <span className="queued-site">{ingredient.name}</span>
                  <span className="queued-meta">{category?.name}</span>
                </div>
                <EditorOnly
                  fallback={
                    ingredient.pantry_staple && (
                      <span className="badge badge-attention">Pantry Staple</span>
                    )
                  }
                >
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={ingredient.pantry_staple}
                    aria-disabled={busy}
                    disabled={!!blocked}
                    onClick={() => toggle(ingredient)}
                  >
                    {busy ? "Saving…" : "Pantry Staple"}
                    <span className="visually-hidden"> {ingredient.name}</span>
                  </button>
                </EditorOnly>
              </li>
            );
          })}
        </ul>
      )}
      <Toast toast={toast} onDone={dismiss} />
    </section>
  );
}
