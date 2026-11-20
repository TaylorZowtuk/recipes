import { formatAmount } from "./amount";
import type { OurVersionDraft, Recipe, RecipeOperation } from "./api/client";
import { type LineDraft, type LineEdit, type LineOf, lineOf } from "./factEdits";
import { effective, overlay } from "./ourVersion";

type Ours = NonNullable<Recipe["our_version"]>;
type StoredLine = Ours["ingredients"]["edit"][string];
type Lines = OurVersionDraft["ingredients"];
type Steps = OurVersionDraft["steps"];
export type OurLineFields = Lines["edit"][string];
type Part = "ingredients" | "steps";
// Where an added line or step goes: after the effective one `after` names, or first for none.
type Place = { after: string | null; component: string | null };

// Our Version as Edit drafts it: what it edits, removes and adds, as the API takes them, and its
// note as typed. `forms` keeps the edit form of each line edited or added in this Edit, so editing
// it again starts where it was left, and `removed` says Save removes Our Version.
export type OurDraft = { ingredients: Lines; steps: Steps; note: string } & {
  forms: Record<string, LineDraft>;
  removed: boolean;
};

// A line's fields as the API takes them, always in one order, so a line saved again as it was
// compares equal to the stored one.
function fieldsOf(line: Omit<OurLineFields, "component">, component: string | null): OurLineFields {
  return {
    quantity: line.quantity,
    unit: line.unit,
    name: line.name,
    preparation: line.preparation,
    fdc_id: line.fdc_id,
    portion_id: line.portion_id,
    ...(line.canonical && { canonical: line.canonical }),
    ...(line.keep_weight != null && { keep_weight: line.keep_weight }),
    component,
  };
}

const storedFields = ({ parse, match, component }: StoredLine) =>
  fieldsOf(
    {
      quantity: parse.quantity,
      unit: parse.unit,
      name: parse.name,
      preparation: parse.preparation,
      fdc_id: match?.fdc_id ?? null,
      portion_id: match?.portion_id ?? null,
    },
    component,
  );

const mapValues = <T, R>(record: Record<string, T>, f: (value: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]));

// The draft of the recipe's stored Our Version, or an empty one.
export function ourDraftOf(recipe: Recipe): OurDraft {
  const ours = recipe.our_version;
  return {
    ingredients: {
      edit: mapValues(ours?.ingredients.edit ?? {}, storedFields),
      remove: [...(ours?.ingredients.remove ?? [])],
      add: (ours?.ingredients.add ?? []).map((line) => ({
        id: line.id,
        after: line.after,
        ...storedFields(line),
      })),
    },
    steps: {
      edit: mapValues(ours?.steps.edit ?? {}, ({ text, component }) => ({ text, component })),
      remove: [...(ours?.steps.remove ?? [])],
      add: (ours?.steps.add ?? []).map(({ id, after, text, component }) => ({
        id,
        after,
        text,
        component,
      })),
    },
    note: ours?.note ?? "",
    forms: {},
    removed: false,
  };
}

// The part as the API takes it. An added line or step after one the draft removes follows the
// effective one before it instead.
function anchored<P extends Lines | Steps>(items: { id: string }[], part: P): P {
  const removed = new Set(part.remove);
  const shown = overlay(
    items,
    { remove: [], add: part.add as { id: string; after: string | null }[] },
    (item) => item.id,
    (item) => item.id,
  ).filter((id) => !removed.has(id));
  const add = part.add.map((item) =>
    item.after !== null && removed.has(item.after)
      ? { ...item, after: shown[shown.indexOf(item.id ?? "") - 1] ?? null }
      : item,
  );
  return { ...part, remove: part.remove.toSorted(), add };
}

function asSaved(recipe: Recipe, draft: OurDraft): OurVersionDraft {
  return {
    ingredients: anchored(recipe.original.ingredients, draft.ingredients),
    steps: anchored(recipe.original.steps, draft.steps),
    note: draft.note.trim() || null,
  };
}

// The PATCH operation for what the draft changes in Our Version, if anything.
export function ourOperation(recipe: Recipe, draft: OurDraft): RecipeOperation | undefined {
  if (draft.removed) return recipe.our_version ? { op: "remove_our_version" } : undefined;
  const ours = asSaved(recipe, draft);
  const stored = asSaved(recipe, ourDraftOf(recipe));
  return JSON.stringify(ours) === JSON.stringify(stored)
    ? undefined
    : { op: "set_our_version", our_version: ours };
}

// A name for an added line or step until the API gives it an id.
function draftId(draft: OurDraft) {
  const ids = new Set([...draft.ingredients.add, ...draft.steps.add].map((item) => item.id));
  let n = 1;
  while (ids.has(`new-${n}`)) n++;
  return `new-${n}`;
}

// Puts an added item directly after the one it follows, ahead of any added there before.
function placed<A extends { after: string | null }>(add: A[], item: A): A[] {
  const at = add.findIndex((other) => other.after === item.after);
  return at < 0 ? [...add, item] : add.toSpliced(at, 0, item);
}

// The line edited as its form saved it: an added line keeps its place, an Original line its
// component, as Our Version or the Original has it.
export function editLine(
  recipe: Recipe,
  draft: OurDraft,
  id: string,
  edit: LineEdit,
  form: LineDraft,
): OurDraft {
  const lines = draft.ingredients;
  const added = lines.add.find((line) => line.id === id);
  const forms = { ...draft.forms, [id]: form };
  if (added) {
    const line = { id, after: added.after, ...fieldsOf(edit, added.component ?? null) };
    const add = lines.add.map((other) => (other.id === id ? line : other));
    return { ...draft, forms, ingredients: { ...lines, add } };
  }
  const component =
    id in lines.edit
      ? (lines.edit[id]?.component ?? null)
      : (recipe.original.ingredients.find((line) => line.id === id)?.component ?? null);
  const edited = { ...lines.edit, [id]: fieldsOf(edit, component) };
  return { ...draft, forms, ingredients: { ...lines, edit: edited } };
}

export function addLine(draft: OurDraft, place: Place, edit: LineEdit, form: LineDraft): OurDraft {
  const id = draftId(draft);
  const line = { id, after: place.after, ...fieldsOf(edit, place.component) };
  const ingredients = { ...draft.ingredients, add: placed(draft.ingredients.add, line) };
  return { ...draft, ingredients, forms: { ...draft.forms, [id]: form } };
}

// The step with its new text. An Original step given its own text back is no edit.
export function editStep(recipe: Recipe, draft: OurDraft, id: string, text: string): OurDraft {
  const steps = draft.steps;
  if (steps.add.some((step) => step.id === id)) {
    const add = steps.add.map((step) => (step.id === id ? { ...step, text } : step));
    return { ...draft, steps: { ...steps, add } };
  }
  const original = recipe.original.steps.find((step) => step.id === id);
  const { [id]: was, ...edit } = steps.edit;
  if (text !== original?.text)
    edit[id] = { text, component: was ? (was.component ?? null) : (original?.component ?? null) };
  return { ...draft, steps: { ...steps, edit } };
}

export function addStep(draft: OurDraft, place: Place, text: string): OurDraft {
  const step = { id: draftId(draft), after: place.after, text, component: place.component };
  return { ...draft, steps: { ...draft.steps, add: placed(draft.steps.add, step) } };
}

// Removes an Original line or step from Our Version, or drops an added one, whose followers then
// follow the one it followed.
export function removeItem(draft: OurDraft, part: Part, id: string): OurDraft {
  const { [id]: _, ...forms } = draft.forms;
  const items: Lines | Steps = draft[part];
  const added = items.add.find((item) => item.id === id);
  if (added) {
    const add = items.add
      .filter((item) => item.id !== id)
      .map((item) => (item.after === id ? { ...item, after: added.after } : item));
    return { ...draft, forms, [part]: { ...items, add } };
  }
  const { [id]: __, ...edit } = items.edit;
  const remove = items.remove.includes(id) ? items.remove : [...items.remove, id];
  return { ...draft, forms, [part]: { ...items, edit, remove } };
}

// Brings an Original line or step back as the Original has it.
export function restoreItem(draft: OurDraft, part: Part, id: string): OurDraft {
  const { [id]: _, ...forms } = draft.forms;
  const items: Lines | Steps = draft[part];
  const { [id]: __, ...edit } = items.edit;
  const remove = items.remove.filter((other) => other !== id);
  return { ...draft, forms, [part]: { ...items, edit, remove } };
}

// A line or step as Edit lists it: the Original's, or how the draft changes it. A removed one stays
// in place so it can be restored.
export type Row = {
  id: string;
  component: string | null;
  text: string;
  change?: "edited" | "added" | "removed";
};

// A line's text as the recipe view shows its parse: "2 tbsp butter, softened".
function lineText(line: OurLineFields) {
  const amount = line.quantity ? formatAmount(line.quantity, line.unit) : line.unit;
  const named = [amount, line.name].filter(Boolean).join(" ");
  return line.preparation ? `${named}, ${line.preparation}` : named;
}

// The stored line's text while the draft has it as stored, else one built from its fields.
function textOf(line: OurLineFields, stored: StoredLine | undefined) {
  const same = stored && JSON.stringify(storedFields(stored)) === JSON.stringify(line);
  return same ? stored.text : lineText(line);
}

export function ourRows(recipe: Recipe, draft: OurDraft): Record<Part, Row[]> {
  const ours = recipe.our_version;
  const lines = draft.ingredients;
  const storedAdds = new Map(ours?.ingredients.add.map((line) => [line.id, line]));
  const ingredients = overlay(
    recipe.original.ingredients,
    { remove: [], add: lines.add.map((line) => ({ ...line, id: line.id ?? "" })) },
    (line): Row => {
      const edit = lines.edit[line.id];
      if (lines.remove.includes(line.id)) return { ...line, change: "removed" };
      if (!edit) return line;
      const text = textOf(edit, ours?.ingredients.edit[line.id]);
      return { id: line.id, component: edit.component ?? null, text, change: "edited" };
    },
    (line): Row => ({
      id: line.id,
      component: line.component ?? null,
      text: textOf(line, storedAdds.get(line.id)),
      change: "added",
    }),
  );
  const steps = draft.steps;
  const stepRows = overlay(
    recipe.original.steps,
    { remove: [], add: steps.add.map((step) => ({ ...step, id: step.id ?? "" })) },
    (step): Row => {
      const edit = steps.edit[step.id];
      if (steps.remove.includes(step.id)) return { ...step, change: "removed" };
      if (!edit) return step;
      return { id: step.id, component: edit.component ?? null, text: edit.text, change: "edited" };
    },
    (step): Row => ({
      id: step.id,
      component: step.component ?? null,
      text: step.text,
      change: "added",
    }),
  );
  return { ingredients, steps: stepRows };
}

// The line as its edit form starts from: as stored Our Version has it, else the Original, else a
// new line with no facts.
export function lineFor(recipe: Recipe, id: string): LineOf {
  const view = effective(recipe, "ours");
  if (view.original.ingredients.some((line) => line.id === id)) return lineOf(view, id);
  if (recipe.original.ingredients.some((line) => line.id === id)) return lineOf(recipe, id);
  return { id, text: "" };
}
