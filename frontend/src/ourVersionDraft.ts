import { formatAmount } from "./amount";
import type {
  IngredientFacts,
  OurVersionDraft,
  Recipe,
  RecipeOperation,
  SubstituteDraft,
} from "./api/client";
import {
  type LineDraft,
  type LineEdit,
  type LineOf,
  lineOf,
  type SubstituteLine,
} from "./factEdits";
import { effective, overlay } from "./ourVersion";

type Ours = NonNullable<Recipe["our_version"]>;
type StoredLine = Ours["ingredients"]["edit"][string];
type Lines = OurVersionDraft["ingredients"];
type Steps = OurVersionDraft["steps"];
export type OurLineFields = Lines["edit"][string];
export type Part = "ingredients" | "steps";
// Where an added line or step goes: after the effective one `after` names, or first for none.
export type Place = { after: string | null; component: string | null };

// Our Version as Edit drafts it: what it edits, removes and adds, as the API takes them, and its
// note as typed. `forms` keeps the edit form of each line edited or added in this Edit, so editing
// it again starts where it was left, and `removed` says Save removes Our Version.
export type OurDraft = { ingredients: Lines; steps: Steps; note: string } & {
  forms: Record<string, LineDraft>;
  removed: boolean;
};

// A line's fields as the API takes them.
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

// A stored Our Version line's fields, from its facts in Our Version's map.
function storedFields(facts: IngredientFacts | undefined, component: string | null): OurLineFields {
  const { parse, match } = facts ?? {};
  return fieldsOf(
    {
      quantity: parse?.quantity ?? null,
      unit: parse?.unit ?? null,
      name: parse?.name ?? "",
      preparation: parse?.preparation ?? null,
      fdc_id: match?.fdc_id ?? null,
      portion_id: match?.portion_id ?? null,
    },
    component,
  );
}

type Canonical = OurLineFields["canonical"];
const sameCanonical = (a: Canonical, b: Canonical) =>
  !a || !b
    ? !a && !b
    : a.kind === "existing" && b.kind === "existing"
      ? a.id === b.id
      : a.kind === "new" &&
        b.kind === "new" &&
        a.name === b.name &&
        a.family === b.family &&
        a.store_category_id === b.store_category_id;

// Whether two drafts of a line save the same, field by field: no weight choice is null, as is no
// component.
function sameLine(a: OurLineFields, b: OurLineFields): boolean {
  return (
    a.quantity?.low === b.quantity?.low &&
    a.quantity?.high === b.quantity?.high &&
    a.unit === b.unit &&
    a.name === b.name &&
    a.preparation === b.preparation &&
    a.fdc_id === b.fdc_id &&
    a.portion_id === b.portion_id &&
    sameCanonical(a.canonical, b.canonical) &&
    (a.keep_weight ?? null) === (b.keep_weight ?? null) &&
    (a.component ?? null) === (b.component ?? null)
  );
}

const sameSubstitute = (a: SubstituteDraft, b: SubstituteDraft) =>
  sameCanonical(a.canonical, b.canonical) &&
  (a.wording ?? null) === (b.wording ?? null) &&
  a.ratio === b.ratio &&
  a.note === b.note &&
  a.fdc_id === b.fdc_id &&
  a.portion_id === b.portion_id;

// Whether two drafts hold the same household substitutions for the same lines.
function sameSubstitutions(a: Lines["substitutions"], b: Lines["substitutions"]): boolean {
  const held = Object.entries(a);
  return (
    held.length === Object.keys(b).length &&
    held.every(([id, x]) => id in b && sameList(x, b[id] ?? [], sameSubstitute))
  );
}

const sameStep = (a: Steps["edit"][string], b: Steps["edit"][string]) =>
  a.text === b.text && (a.component ?? null) === (b.component ?? null);

const sameList = <T>(a: T[], b: T[], same: (x: T, y: T) => boolean) =>
  a.length === b.length && a.every((x, i) => i in b && same(x, b[i] as T));

type Drafted<E> = { edit: Record<string, E>; remove: string[]; add: (E & Added)[] };
type Added = { id?: string | null; after: string | null };

// Whether two drafts of a part save the same: the same edits by id, the same removals in order
// (`anchored` sorts them) and the same additions in order.
function samePart<E>(a: Drafted<E>, b: Drafted<E>, same: (x: E, y: E) => boolean): boolean {
  const edits = Object.entries(a.edit);
  const sameAdded = (x: E & Added, y: E & Added) =>
    (x.id ?? null) === (y.id ?? null) && x.after === y.after && same(x, y);
  return (
    edits.length === Object.keys(b.edit).length &&
    edits.every(([id, x]) => id in b.edit && same(x, b.edit[id] as E)) &&
    sameList(a.remove, b.remove, (x, y) => x === y) &&
    sameList(a.add, b.add, sameAdded)
  );
}

const mapValues = <T, R>(
  record: Record<string, T>,
  f: (value: T, key: string) => R,
): Record<string, R> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value, key)]));

// The draft of the recipe's stored Our Version, or an empty one.
export function ourDraftOf(recipe: Recipe): OurDraft {
  const ours = recipe.our_version;
  return {
    ingredients: {
      edit: mapValues(ours?.ingredients.edit ?? {}, (line, id) =>
        storedFields(ours?.facts.ingredients[id], line.component),
      ),
      remove: [...(ours?.ingredients.remove ?? [])],
      add: (ours?.ingredients.add ?? []).map((line) => ({
        id: line.id,
        after: line.after,
        ...storedFields(ours?.facts.ingredients[line.id], line.component),
      })),
      substitutions: storedSubstitutions(ours),
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

// Our Version's household substitutions as stored, by line id, so a save keeps them as they are.
function storedSubstitutions(ours: Ours | null | undefined): Lines["substitutions"] {
  return Object.fromEntries(
    Object.entries(ours?.facts.ingredients ?? {}).flatMap(([id, facts]) =>
      facts.substitutions
        ? [
            [
              id,
              facts.substitutions.items.map(({ canonical_id, wording, ratio, note, ...food }) => ({
                canonical: { kind: "existing" as const, id: canonical_id },
                wording,
                ratio,
                note,
                fdc_id: food.fdc_id,
                portion_id: food.portion_id,
              })),
            ],
          ]
        : [],
    ),
  );
}

// The substitutions a line shows without household ones of its own: none for a line the draft
// edits or adds, else the Original's, each kept with the wording the recipe quotes.
function recipeSubstitutes(recipe: Recipe, draft: OurDraft, id: string): SubstituteDraft[] {
  const lines = draft.ingredients;
  if (id in lines.edit || lines.add.some((line) => line.id === id)) return [];
  return (recipe.facts.ingredients[id]?.substitutions?.items ?? []).map(
    ({ canonical_id, wording, ratio, note, fdc_id, portion_id }) => ({
      canonical: { kind: "existing", id: canonical_id },
      wording,
      ratio,
      note,
      fdc_id,
      portion_id,
    }),
  );
}

// The substitutions a line shows in the draft, which its form starts from: its household ones
// when the draft holds them, else the recipe's.
export function substitutesFor(recipe: Recipe, draft: OurDraft, id: string): SubstituteDraft[] {
  return draft.ingredients.substitutions[id] ?? recipeSubstitutes(recipe, draft, id);
}

// The line's household substitutions set to `substitutes`, an empty list for none. A line that
// Our Version doesn't hold any for as stored holds none while they are what it shows without.
export function setSubstitutions(
  recipe: Recipe,
  draft: OurDraft,
  id: string,
  substitutes: SubstituteDraft[],
): OurDraft {
  const lines = draft.ingredients;
  const { [id]: _, ...others } = lines.substitutions;
  const stored = id in storedSubstitutions(recipe.our_version);
  const unheld =
    !stored && sameList(substitutes, recipeSubstitutes(recipe, draft, id), sameSubstitute);
  const substitutions = unheld ? others : { ...others, [id]: substitutes };
  return { ...draft, ingredients: { ...lines, substitutions } };
}

// The household substitutions of the lines the draft still has: none for a line it removes.
function heldSubstitutions(recipe: Recipe, lines: Lines): Lines["substitutions"] {
  const removed = new Set(lines.remove);
  const shown = new Set([
    ...recipe.original.ingredients.map((line) => line.id).filter((id) => !removed.has(id)),
    ...lines.add.flatMap((line) => (line.id ? [line.id] : [])),
  ]);
  return Object.fromEntries(Object.entries(lines.substitutions).filter(([id]) => shown.has(id)));
}

function asSaved(recipe: Recipe, draft: OurDraft): OurVersionDraft {
  return {
    ingredients: {
      ...anchored(recipe.original.ingredients, draft.ingredients),
      substitutions: heldSubstitutions(recipe, draft.ingredients),
    },
    steps: anchored(recipe.original.steps, draft.steps),
    note: draft.note.trim() || null,
  };
}

// The PATCH operation for what the draft changes in Our Version, if anything.
export function ourOperation(recipe: Recipe, draft: OurDraft): RecipeOperation | undefined {
  if (draft.removed) return recipe.our_version ? { op: "remove_our_version" } : undefined;
  const ours = asSaved(recipe, draft);
  const stored = asSaved(recipe, ourDraftOf(recipe));
  const same =
    samePart(ours.ingredients, stored.ingredients, sameLine) &&
    sameSubstitutions(ours.ingredients.substitutions, stored.ingredients.substitutions) &&
    samePart(ours.steps, stored.steps, sameStep) &&
    ours.note === stored.note;
  return same ? undefined : { op: "set_our_version", our_version: ours };
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

type LineParse = Pick<OurLineFields, "quantity" | "unit" | "name" | "preparation"> & {
  comment: string | null;
};

// A line's text as the recipe view shows its parse, as the API's `line_text` builds it:
// "2 tbsp butter, softened, or to taste".
export function lineText(line: LineParse) {
  const amount = line.quantity ? formatAmount(line.quantity, line.unit) : line.unit;
  const named = [amount, line.name].filter(Boolean).join(" ");
  return [named, line.preparation, line.comment].filter(Boolean).join(", ");
}

// The stored line's text while the draft has it as stored, else one built from its fields and the
// comment of the line it replaces, Our Version's or else the Original's, as the API builds it.
function textOf(
  line: OurLineFields,
  stored: StoredLine | undefined,
  facts: IngredientFacts | undefined,
  original?: IngredientFacts,
) {
  const same = stored && sameLine(storedFields(facts, stored.component), line);
  const comment = (facts ?? original)?.parse?.comment ?? null;
  return same ? stored.text : lineText({ ...line, comment });
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
      const text = textOf(
        edit,
        ours?.ingredients.edit[line.id],
        ours?.facts.ingredients[line.id],
        recipe.facts.ingredients[line.id],
      );
      return { id: line.id, component: edit.component ?? null, text, change: "edited" };
    },
    (line): Row => ({
      id: line.id,
      component: line.component ?? null,
      text: textOf(line, storedAdds.get(line.id), ours?.facts.ingredients[line.id]),
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

// The line a substitute stands in for, as the draft has it: its unit and amount, and its Canonical
// Ingredient, the one the draft picks or else the one it has.
export function substituteLine(recipe: Recipe, draft: OurDraft, id: string): SubstituteLine {
  const lines = draft.ingredients;
  const drafted = lines.edit[id] ?? lines.add.find((line) => line.id === id);
  const facts = lineFor(recipe, id).facts;
  const picked = drafted?.canonical;
  const canonicalId =
    picked?.kind === "existing" ? picked.id : picked ? undefined : facts?.match?.canonical_id;
  if (drafted)
    return { unit: drafted.unit, unitKind: null, hasAmount: !!drafted.quantity, canonicalId };
  const parse = facts?.parse;
  return {
    unit: parse?.unit ?? null,
    unitKind: parse?.unit_kind ?? null,
    hasAmount: !!parse?.quantity,
    canonicalId,
  };
}
