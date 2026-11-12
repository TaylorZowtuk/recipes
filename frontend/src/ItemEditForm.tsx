import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { DifficultyChoice } from "./addRecipe";
import type { Collection, Recipe } from "./api/client";
import {
  type Built,
  type CanonicalPick,
  canConvert,
  canonicalNote,
  difficultyEdit,
  type LineDraft,
  lineDraft,
  lineEdit,
  lineName,
  renamed,
  stepDraft,
  stepEdit,
  stepRows,
  substitutionEdit,
  withWording,
} from "./factEdits";
import { DifficultyField } from "./RecipeFields";
import type { FactEdit, ReviewItem } from "./review";
import { alphabetical, titleMatches } from "./titleSearch";

type Kitchen = Pick<Collection, "canonical_ingredients" | "kitchen_settings" | "wordings">;

// Saves the edit, answering why it wasn't saved, or null once it was or the recipe changed
// elsewhere, when the sheet closes.
export type SaveEdit = (edit: FactEdit) => Promise<string | null>;

type FormProps = {
  item: ReviewItem;
  recipe: Recipe;
  collection: Kitchen;
  disabled: boolean;
  note?: ReactNode;
  onSave: SaveEdit;
  onCancel: () => void;
};

// Whether the item has facts an editor can edit: a line always, a step with portions or timers,
// substitutions while there are any, and the Difficulty.
export function canEdit(item: ReviewItem, recipe: Recipe): boolean {
  const [owner = ""] = item.id.split(".");
  switch (item.kind) {
    case "difficulty":
    case "line":
      return true;
    case "substitutions":
      return !!recipe.facts.ingredients[owner]?.substitutions?.items.length;
    case "step": {
      const rows = stepRows(recipe, owner);
      return rows.portions.length + rows.timers.length > 0;
    }
  }
}

// The edit form for the item's kind, in place of its detail in the same sheet.
export function ItemEditForm(props: FormProps) {
  const [owner = ""] = props.item.id.split(".");
  switch (props.item.kind) {
    case "difficulty":
      return <DifficultyForm {...props} />;
    case "substitutions":
      return <SubstitutionsForm lineId={owner} {...props} />;
    case "line":
      return <LineForm lineId={owner} {...props} />;
    case "step":
      return <StepForm stepId={owner} {...props} />;
  }
}

type Problem = { problem: string; field?: string };

// Why the last Save didn't save, by the id of the text that says so, and the field at fault.
const ProblemOf = createContext<{ id: string; field?: string } | null>(null);

function useSave(onSave: SaveEdit) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const save = async (built: Built) => {
    if ("problem" in built) return setProblem(built);
    setProblem(null);
    setSaving(true);
    const refused = await onSave(built.edit);
    setSaving(false);
    setProblem(refused === null ? null : { problem: refused });
  };
  const shown = problem && (
    <p id={id} role="alert" className="form-problem item-edit-problem">
      {problem.problem}
    </p>
  );
  return { problem: problem && { id, field: problem.field }, shown, saving, save };
}

// The offline or paused note, pinned with the buttons it explains, which it describes.
function Note({ id, note }: { id: string; note: ReactNode }) {
  return (
    <div id={id} className="item-edit-note">
      {note}
    </div>
  );
}

// The form, its first field focused as it opens, with Cancel and Save pinned at the sheet's foot,
// and above them any offline or paused note and why the last Save didn't save.
function EditForm({
  build,
  onSave,
  onCancel,
  disabled,
  note,
  children,
}: {
  build: () => Built;
  children: ReactNode;
} & Pick<FormProps, "onSave" | "onCancel" | "disabled" | "note">) {
  const form = useRef<HTMLFormElement>(null);
  const { problem, shown, saving, save } = useSave(onSave);
  const noteId = useId();
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);
  return (
    <ProblemOf value={problem}>
      <form
        ref={form}
        className="review-form item-edit"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save(build());
        }}
      >
        {children}
        <div className="sheet-actions">
          {note && <Note id={noteId} note={note} />}
          {shown}
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="button"
            disabled={disabled || saving}
            aria-describedby={note ? noteId : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </ProblemOf>
  );
}

// A field, described by its hint, any hint it shares (`describedBy`), and the last Save's problem
// when that names this field, by its `name`, else its label.
function Field({
  label,
  name = label,
  value,
  onChange,
  hint,
  describedBy,
  decimal = false,
}: {
  label: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  describedBy?: string;
  decimal?: boolean;
}) {
  const id = useId();
  const problem = useContext(ProblemOf);
  const invalid = !!problem && problem.field === name;
  const described = [hint && `${id}-hint`, describedBy, invalid && problem.id].filter(Boolean);
  return (
    <div className="edit-field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      <input
        id={id}
        className="text-input"
        autoComplete="off"
        inputMode={decimal ? "decimal" : undefined}
        aria-describedby={described.length ? described.join(" ") : undefined}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Choice({
  group,
  checked,
  onChange,
  children,
}: {
  group: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label className="choice">
      <input
        type="radio"
        className="visually-hidden"
        name={group}
        checked={checked}
        onChange={onChange}
      />
      <span className="choice-text">{children}</span>
    </label>
  );
}

function LineForm({ lineId, recipe, collection, ...props }: FormProps & { lineId: string }) {
  const [draft, setDraft] = useState(() => lineDraft(recipe, lineId));
  const set = (patch: Partial<LineDraft>) => setDraft((was) => ({ ...was, ...patch }));
  const weight = useId();
  const amountHint = useId();
  // What saving sends, which picks a Canonical Ingredient once the name's wording changed.
  const saved = withWording(recipe, lineId, draft, collection);
  const kept = saved.canonical.kind === "keep";
  return (
    <EditForm build={() => lineEdit(recipe, lineId, saved)} {...props}>
      <fieldset className="sheet-section">
        <legend>Line</legend>
        <div className="edit-pair">
          <Field
            label="Amount"
            decimal
            describedBy={amountHint}
            value={draft.low}
            onChange={(low) => set({ low })}
          />
          <Field
            label="Up to"
            decimal
            describedBy={amountHint}
            value={draft.high}
            onChange={(high) => set({ high })}
          />
        </div>
        <p id={amountHint} className="field-hint">
          Such as 2, 1.5 or 1 1/2. Leave it empty for none, as in “to taste”.
        </p>
        <Field label="Unit" value={draft.unit} onChange={(unit) => set({ unit })} />
        <Field label="Name" value={draft.name} onChange={(name) => set({ name })} />
        <Field
          label="Preparation"
          value={draft.preparation}
          onChange={(preparation) => set({ preparation })}
        />
      </fieldset>
      <CanonicalPicker
        recipe={recipe}
        lineId={lineId}
        collection={collection}
        pick={saved.canonical}
        reach={canonicalNote(saved, collection, recipe)}
        renamed={renamed(recipe, lineId, draft.name)}
        onPick={(canonical) => set({ canonical })}
      />
      {kept && draft.keepWeight !== null && canConvert(recipe, lineId) && (
        <fieldset className="sheet-section">
          <legend>Weight</legend>
          <div className="choices">
            <Choice
              group={weight}
              checked={!draft.keepWeight}
              onChange={() => set({ keepWeight: false })}
            >
              Convert to a weight
            </Choice>
            <Choice
              group={weight}
              checked={draft.keepWeight}
              onChange={() => set({ keepWeight: true })}
            >
              Keep the written unit
            </Choice>
          </div>
        </fieldset>
      )}
    </EditForm>
  );
}

const SHOWN_MATCHES = 6;

// Keep the line's Canonical Ingredient, pick it again, pick another found by name, or create one
// from the search, and under the choices, what the pick reaches. Picking it again shares it with
// every line worded like this one, which retries the recipes an earlier save couldn't update. A
// renamed line can't keep it, but may pick it again.
function CanonicalPicker({
  recipe,
  lineId,
  collection,
  pick,
  reach,
  renamed,
  onPick,
}: {
  recipe: Recipe;
  lineId: string;
  collection: Kitchen;
  pick: CanonicalPick;
  reach: string | null;
  renamed: boolean;
  onPick: (pick: CanonicalPick) => void;
}) {
  const group = useId();
  const categories = useId();
  const [query, setQuery] = useState("");
  const all = collection.canonical_ingredients;
  const currentId = recipe.facts.ingredients[lineId]?.match?.canonical_id;
  const current = all.find((c) => c.id === currentId);
  const q = query.trim();
  const found = q
    ? all
        .filter((c) => c.id !== currentId && titleMatches(c.name, q))
        .sort((a, b) => alphabetical(a.name, b.name))
        .slice(0, SHOWN_MATCHES)
    : [];
  const picked = pick.kind === "existing" && all.find((c) => c.id === pick.id);
  const offered = current && current !== picked ? [current, ...found] : found;
  const shown = picked && !offered.includes(picked) ? [picked, ...offered] : offered;
  const exact = all.some((c) => alphabetical(c.name, q) === 0);
  return (
    <fieldset className="sheet-section">
      <legend>Canonical Ingredient</legend>
      <Field
        label="Find or create one"
        hint="Search the Canonical Ingredients by name."
        value={query}
        onChange={setQuery}
      />
      {renamed && (
        <p className="field-hint item-edit-found">
          The name’s wording changed, so choose its Canonical Ingredient.
        </p>
      )}
      <div className="choices">
        {!renamed && (
          <Choice
            group={group}
            checked={pick.kind === "keep"}
            onChange={() => onPick({ kind: "keep" })}
          >
            {current ? `Keep ${current.name}` : "Keep none"}
          </Choice>
        )}
        {shown.map((c) => (
          <Choice
            key={c.id}
            group={group}
            checked={pick.kind === "existing" && pick.id === c.id}
            onChange={() => onPick({ kind: "existing", id: c.id })}
          >
            {c.name}
          </Choice>
        ))}
        {(pick.kind === "new" || (q && !exact)) && (
          <Choice
            group={group}
            checked={pick.kind === "new"}
            onChange={() => onPick({ kind: "new", name: q, family: "", storeCategoryId: "" })}
          >
            New: {pick.kind === "new" ? pick.name || "…" : q}
          </Choice>
        )}
      </div>
      <p role="status" className={reach ? "review-note item-edit-reach" : "visually-hidden"}>
        {reach}
      </p>
      {q && shown.length === 0 && exact === false && (
        <p className="field-hint item-edit-found">No Canonical Ingredient is named “{q}”.</p>
      )}
      {pick.kind === "new" && (
        <div className="item-edit-new">
          <Field
            label="New name"
            value={pick.name}
            onChange={(name) => onPick({ ...pick, name })}
          />
          <Field
            label="Family"
            hint="A lowercase word that groups it, such as rice or dairy."
            value={pick.family}
            onChange={(family) => onPick({ ...pick, family })}
          />
          <fieldset className="sheet-section">
            <legend>Store Category</legend>
            <div className="choices">
              {collection.kitchen_settings.store_categories.map((category) => (
                <Choice
                  key={category.id}
                  group={categories}
                  checked={pick.storeCategoryId === category.id}
                  onChange={() => onPick({ ...pick, storeCategoryId: category.id })}
                >
                  {category.name}
                </Choice>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </fieldset>
  );
}

function StepForm({ stepId, recipe, ...props }: FormProps & { stepId: string }) {
  const rows = stepRows(recipe, stepId);
  const [draft, setDraft] = useState(() => stepDraft(recipe, stepId));
  const portionsHint = useId();
  return (
    <EditForm build={() => stepEdit(stepId, draft)} {...props}>
      {rows.portions.length > 0 && (
        <fieldset className="sheet-section">
          <legend>Step Portions</legend>
          <p id={portionsHint} className="field-hint">
            How much of each line this step uses: 1 is all of it, 1/2 half.
          </p>
          {rows.portions.map((row, n) => (
            <Field
              // biome-ignore lint/suspicious/noArrayIndexKey: a step's segments never reorder.
              key={n}
              label={
                row.written
                  ? `“${row.written}”, ${lineName(recipe, row.ref)}`
                  : lineName(recipe, row.ref)
              }
              name={`portion-${n}`}
              describedBy={portionsHint}
              decimal
              value={draft.portions[n] ?? ""}
              onChange={(value) =>
                setDraft((was) => ({ ...was, portions: was.portions.with(n, value) }))
              }
            />
          ))}
        </fieldset>
      )}
      {rows.timers.map((timer, n) => {
        const typed = draft.timers[n] ?? { low: "", high: "" };
        const setTimer = (patch: Partial<typeof typed>) =>
          setDraft((was) => ({ ...was, timers: was.timers.with(n, { ...typed, ...patch }) }));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a step's segments never reorder.
          <fieldset key={n} className="sheet-section">
            <legend>Timer “{timer.written}”</legend>
            <div className="edit-pair">
              <Field
                label="From, minutes"
                name={`timer-${n}`}
                decimal
                value={typed.low}
                onChange={(low) => setTimer({ low })}
              />
              <Field
                label="To, minutes"
                decimal
                value={typed.high}
                onChange={(high) => setTimer({ high })}
              />
            </div>
          </fieldset>
        );
      })}
    </EditForm>
  );
}

function DifficultyForm({ recipe, ...props }: FormProps) {
  const [difficulty, setDifficulty] = useState<DifficultyChoice>(() => {
    const suggested = recipe.facts.difficulty;
    return suggested
      ? { prep: suggested.prep, cook: suggested.cook, cleanup: suggested.cleanup }
      : (recipe.difficulty ?? {});
  });
  return (
    <EditForm build={() => difficultyEdit(difficulty)} {...props}>
      <DifficultyField difficulty={difficulty} onChange={setDifficulty} required />
    </EditForm>
  );
}

// Each substitute saves or goes on its own, as the API edits one at a time; Cancel goes back.
function SubstitutionsForm({
  lineId,
  recipe,
  disabled,
  note,
  onSave,
  onCancel,
}: FormProps & { lineId: string }) {
  const items = recipe.facts.ingredients[lineId]?.substitutions?.items ?? [];
  const first = useRef<HTMLDivElement>(null);
  const noteId = useId();
  useEffect(() => {
    first.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);
  return (
    <div className="review-form item-edit" ref={first}>
      {items.length > 1 && <p className="field-hint">Save each substitute on its own.</p>}
      {items.map((sub, index) => (
        <Substitute
          // biome-ignore lint/suspicious/noArrayIndexKey: the API names a substitute by its index.
          key={`${index}-${sub.wording}`}
          lineId={lineId}
          index={index}
          wording={sub.wording}
          ratio={sub.ratio}
          note={sub.note}
          disabled={disabled}
          noteId={note ? noteId : undefined}
          onSave={onSave}
        />
      ))}
      <div className="sheet-actions">
        {note && <Note id={noteId} note={note} />}
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Substitute({
  lineId,
  index,
  wording,
  ratio,
  note,
  disabled,
  noteId,
  onSave,
}: {
  lineId: string;
  index: number;
  wording: string;
  ratio: number;
  note: string;
  disabled: boolean;
  noteId?: string;
  onSave: SaveEdit;
}) {
  const [typed, setTyped] = useState({ ratio: String(ratio), note });
  const { problem, shown, saving, save } = useSave(onSave);
  return (
    <ProblemOf value={problem}>
      <form
        className="item-edit-substitute"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save(substitutionEdit(lineId, index, typed.ratio, typed.note));
        }}
      >
        <fieldset className="sheet-section">
          <legend>{wording}</legend>
          <Field
            label="Ratio"
            hint="How much to use for each 1 of the line, such as 0.75."
            decimal
            value={typed.ratio}
            onChange={(value) => setTyped((was) => ({ ...was, ratio: value }))}
          />
          <Field
            label="Note"
            value={typed.note}
            onChange={(value) => setTyped((was) => ({ ...was, note: value }))}
          />
          {shown}
          <div className="site-actions">
            <button
              type="submit"
              className="button"
              disabled={disabled || saving}
              aria-describedby={noteId}
            >
              {saving ? "Saving…" : "Save"}
              <span className="visually-hidden"> {wording}</span>
            </button>
            <button
              type="button"
              className="text-button text-button-danger"
              disabled={disabled || saving}
              aria-describedby={noteId}
              onClick={() =>
                save({ edit: { kind: "remove_substitution", line_id: lineId, index } })
              }
            >
              Remove<span className="visually-hidden"> {wording}</span>
            </button>
          </div>
        </fieldset>
      </form>
    </ProblemOf>
  );
}
