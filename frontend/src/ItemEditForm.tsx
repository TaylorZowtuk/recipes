import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
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
  stepDraft,
  stepEdit,
  stepRows,
  substitutionEdit,
} from "./factEdits";
import { DifficultyField } from "./RecipeFields";
import type { FactEdit, ReviewItem } from "./review";
import { alphabetical, titleMatches } from "./titleSearch";

type Kitchen = Pick<Collection, "canonical_ingredients" | "kitchen_settings">;

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
  if (item.id === "difficulty") return true;
  const [owner = ""] = item.id.split(".");
  if (item.id.endsWith(".substitutions"))
    return !!recipe.facts.ingredients[owner]?.substitutions?.items.length;
  if (recipe.original.ingredients.some((line) => line.id === owner)) return true;
  const rows = stepRows(recipe, owner);
  return rows.portions.length + rows.timers.length > 0;
}

// The edit form for the item's kind, in place of its detail in the same sheet.
export function ItemEditForm(props: FormProps) {
  const { item } = props;
  const [owner = ""] = item.id.split(".");
  if (item.id === "difficulty") return <DifficultyForm {...props} />;
  if (item.id.endsWith(".substitutions")) return <SubstitutionsForm lineId={owner} {...props} />;
  if (props.recipe.original.ingredients.some((line) => line.id === owner))
    return <LineForm lineId={owner} {...props} />;
  return <StepForm stepId={owner} {...props} />;
}

function useSave(onSave: SaveEdit) {
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (built: Built) => {
    if ("problem" in built) return setProblem(built.problem);
    setProblem(null);
    setSaving(true);
    const refused = await onSave(built.edit);
    setSaving(false);
    setProblem(refused);
  };
  return { problem, saving, save };
}

// The form, its first field focused as it opens, with Cancel and Save pinned at the sheet's foot,
// and above them any note and why the last Save didn't save.
function EditForm({
  build,
  onSave,
  onCancel,
  disabled,
  note,
  notice,
  children,
}: {
  build: () => Built;
  notice?: string | null;
  children: ReactNode;
} & Pick<FormProps, "onSave" | "onCancel" | "disabled" | "note">) {
  const form = useRef<HTMLFormElement>(null);
  const { problem, saving, save } = useSave(onSave);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);
  return (
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
      {note}
      <div className="sheet-actions">
        {notice && <p className="review-note">{notice}</p>}
        {problem && (
          <p role="alert" className="form-problem item-edit-problem">
            {problem}
          </p>
        )}
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={disabled || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  decimal = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  decimal?: boolean;
}) {
  const id = useId();
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
        aria-describedby={hint ? `${id}-hint` : undefined}
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
  const kept = draft.canonical.kind === "keep";
  return (
    <EditForm
      build={() => lineEdit(recipe, lineId, draft)}
      notice={canonicalNote(draft, collection)}
      {...props}
    >
      <fieldset className="sheet-section">
        <legend>Line</legend>
        <div className="edit-pair">
          <Field label="Amount" decimal value={draft.low} onChange={(low) => set({ low })} />
          <Field label="Up to" decimal value={draft.high} onChange={(high) => set({ high })} />
        </div>
        <p className="field-hint">
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
        pick={draft.canonical}
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

// Keep the line's Canonical Ingredient, pick another found by name, or create one from the search.
function CanonicalPicker({
  recipe,
  lineId,
  collection,
  pick,
  onPick,
}: {
  recipe: Recipe;
  lineId: string;
  collection: Kitchen;
  pick: CanonicalPick;
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
  const shown = picked && !found.includes(picked) ? [picked, ...found] : found;
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
      <div className="choices">
        <Choice
          group={group}
          checked={pick.kind === "keep"}
          onChange={() => onPick({ kind: "keep" })}
        >
          {current ? `Keep ${current.name}` : "Keep none"}
        </Choice>
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
  return (
    <EditForm build={() => stepEdit(stepId, draft)} {...props}>
      {rows.portions.length > 0 && (
        <fieldset className="sheet-section">
          <legend>Step Portions</legend>
          <p className="field-hint">
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
  useEffect(() => {
    first.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);
  return (
    <div className="review-form item-edit" ref={first}>
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
          onSave={onSave}
        />
      ))}
      {note}
      <div className="sheet-actions">
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
  onSave,
}: {
  lineId: string;
  index: number;
  wording: string;
  ratio: number;
  note: string;
  disabled: boolean;
  onSave: SaveEdit;
}) {
  const [typed, setTyped] = useState({ ratio: String(ratio), note });
  const { problem, saving, save } = useSave(onSave);
  return (
    <form
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
        {problem && (
          <p role="alert" className="form-problem">
            {problem}
          </p>
        )}
        <div className="site-actions">
          <button type="submit" className="button" disabled={disabled || saving}>
            {saving ? "Saving…" : "Save"}
            <span className="visually-hidden"> {wording}</span>
          </button>
          <button
            type="button"
            className="text-button text-button-danger"
            disabled={disabled || saving}
            onClick={() => save({ edit: { kind: "remove_substitution", line_id: lineId, index } })}
          >
            Remove<span className="visually-hidden"> {wording}</span>
          </button>
        </div>
      </fieldset>
    </form>
  );
}
