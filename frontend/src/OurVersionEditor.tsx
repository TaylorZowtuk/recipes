import { Fragment, type ReactNode } from "react";
import type { Collection, Recipe } from "./api/client";
import type { RefusedAt } from "./editRecipe";
import { LineForm, StepTextForm } from "./ItemEditForm";
import {
  addLine,
  addStep,
  editLine,
  editStep,
  lineFor,
  type OurDraft,
  ourRows,
  type Part,
  type Place,
  type Row,
  removeItem,
  restoreItem,
} from "./ourVersionDraft";
import { byComponent } from "./recipeComponents";
import { Sheet } from "./Sheet";

// What the Our Version sheet edits: a line or step, or a new one at its place.
export type OurTarget =
  | { part: Part; id: string; title: string }
  | { part: Part; place: Place; title: string };

const MARKS = { edited: "Changed", added: "Added", removed: "Removed" } as const;
const NOUN = { ingredients: "line", steps: "step" } as const;

// Our Version in Edit: the effective lines and steps, each with its change marked, a removed one
// left in place to restore, and the note. Editing or adding opens the sheet; Remove Our Version
// asks first, and Save then removes it.
export function OurVersionFields({
  recipe,
  draft,
  problem,
  refusedAt,
  onChange,
  onOpen,
}: {
  recipe: Recipe;
  draft: OurDraft;
  // The API's refusal of a line or step, shown by it.
  problem?: string | undefined;
  refusedAt?: RefusedAt | undefined;
  onChange: (ours: OurDraft) => void;
  onOpen: (target: OurTarget) => void;
}) {
  if (draft.removed)
    return (
      <fieldset className="our-version-field">
        <legend>Our Version</legend>
        <p className="review-note">Saving removes Our Version and shows the Original.</p>
        <button
          type="button"
          className="text-button"
          onClick={() => onChange({ ...draft, removed: false })}
        >
          Keep Our Version
        </button>
      </fieldset>
    );
  const rows = ourRows(recipe, draft);
  const list = (part: Part) =>
    byComponent(rows[part]).map(({ component, lines }) => (
      <div key={`${part}-${component ?? ""}-${lines[0]?.id}`} className="our-version-part">
        {component && <h4 className="our-version-component">{component}</h4>}
        <ul className="our-version-rows">
          {lines.map((row) => (
            <OurRow
              key={row.id}
              row={row}
              part={part}
              onEdit={() => onOpen({ part, id: row.id, title: `Edit ${row.text}` })}
              onAddAfter={() =>
                onOpen({
                  part,
                  place: { after: row.id, component: row.component },
                  title: `Add a ${NOUN[part]} after ${row.text}`,
                })
              }
              onRemove={() => onChange(removeItem(draft, part, row.id))}
              onRestore={() => onChange(restoreItem(draft, part, row.id))}
            >
              {problem && refusedAt?.part === part && refusedAt.id === row.id && (
                <p role="alert" className="form-problem">
                  {problem}
                </p>
              )}
            </OurRow>
          ))}
        </ul>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onOpen({
              part,
              place: { after: lines.at(-1)?.id ?? null, component },
              title: component ? `Add a ${NOUN[part]} to ${component}` : `Add a ${NOUN[part]}`,
            })
          }
        >
          Add a {NOUN[part]}
          {component && <span className="visually-hidden"> to {component}</span>}
        </button>
      </div>
    ));
  return (
    <fieldset className="our-version-field">
      <legend>Our Version</legend>
      <p className="field-hint">
        Your household’s own lines and steps. The Original stays as it is, and Adjust can show it.
      </p>
      <h3 className="our-version-heading">Ingredients</h3>
      {list("ingredients")}
      {rows.ingredients.length === 0 && <EmptyAdd part="ingredients" onOpen={onOpen} />}
      <h3 className="our-version-heading">Steps</h3>
      <p className="field-hint">A changed step shows as written until enrichment reads it.</p>
      {list("steps")}
      {rows.steps.length === 0 && <EmptyAdd part="steps" onOpen={onOpen} />}
      <label htmlFor="our-version-note">Note</label>
      <textarea
        id="our-version-note"
        className="text-input our-version-note-input"
        rows={2}
        value={draft.note}
        onChange={(event) => onChange({ ...draft, note: event.target.value })}
      />
      {recipe.our_version && (
        <button
          type="button"
          className="text-button text-button-danger"
          onClick={() =>
            window.confirm("Remove Our Version? Saving then shows the Original only.") &&
            onChange({ ...draft, removed: true })
          }
        >
          Remove Our Version
        </button>
      )}
    </fieldset>
  );
}

function EmptyAdd({ part, onOpen }: { part: Part; onOpen: (target: OurTarget) => void }) {
  const title = `Add a ${NOUN[part]}`;
  return (
    <button
      type="button"
      className="text-button"
      onClick={() => onOpen({ part, place: { after: null, component: null }, title })}
    >
      {title}
    </button>
  );
}

function OurRow({
  row,
  part,
  onEdit,
  onAddAfter,
  onRemove,
  onRestore,
  children,
}: {
  row: Row;
  part: Part;
  onEdit: () => void;
  onAddAfter: () => void;
  onRemove: () => void;
  onRestore: () => void;
  children: ReactNode;
}) {
  const removed = row.change === "removed";
  const named = <span className="visually-hidden"> {row.text}</span>;
  return (
    <li className={removed ? "our-version-row our-version-removed" : "our-version-row"}>
      <span className="our-version-text">
        {removed ? <s>{row.text}</s> : row.text}
        {row.change && <span className="our-version-mark"> · {MARKS[row.change]}</span>}
      </span>
      <span className="our-version-actions">
        {!removed && (
          <button type="button" className="text-button" onClick={onEdit}>
            Edit{named}
          </button>
        )}
        {(removed || row.change === "edited") && (
          <button type="button" className="text-button" onClick={onRestore}>
            Restore{named}
          </button>
        )}
        {!removed && (
          <button type="button" className="text-button" onClick={onRemove}>
            Remove{named}
          </button>
        )}
        {!removed && (
          <button type="button" className="text-button" onClick={onAddAfter}>
            Add after<span className="visually-hidden"> {row.text}</span>
            {part === "steps" && <span className="visually-hidden"> a step</span>}
          </button>
        )}
      </span>
      {children}
    </li>
  );
}

// The sheet that edits or adds a line or step in the draft. Done puts it in the draft, which the
// Edit's Save then saves with the rest.
export function OurVersionSheet({
  target,
  recipe,
  draft,
  collection,
  disabled,
  note,
  onChange,
  onClose,
}: {
  target: OurTarget | undefined;
  recipe: Recipe;
  draft: OurDraft;
  collection: Pick<Collection, "canonical_ingredients" | "kitchen_settings" | "wordings">;
  disabled: boolean;
  note?: ReactNode;
  onChange: (ours: OurDraft) => void;
  onClose: () => void;
}) {
  const done = (ours: OurDraft) => {
    onChange(ours);
    onClose();
    return Promise.resolve(null);
  };
  const form = () => {
    if (!target) return null;
    const common = { disabled, note, submit: "Done", onCancel: onClose };
    const id = "id" in target ? target.id : undefined;
    if (target.part === "steps") {
      const text = id ? (ourRows(recipe, draft).steps.find((s) => s.id === id)?.text ?? "") : "";
      return (
        <StepTextForm
          text={text}
          {...common}
          onSave={(text) =>
            done(
              "id" in target
                ? editStep(recipe, draft, target.id, text)
                : addStep(draft, target.place, text),
            )
          }
        />
      );
    }
    const line = lineFor(recipe, id ?? "");
    const original = recipe.original.ingredients.some((l) => l.id === id);
    return (
      <LineForm
        line={line}
        start={id ? draft.forms[id] : undefined}
        required={!original && !line.facts?.match}
        collection={collection}
        {...common}
        onSave={(edit, form) =>
          done(
            "id" in target
              ? editLine(recipe, draft, target.id, edit, form)
              : addLine(draft, target.place, edit, form),
          )
        }
      />
    );
  };
  return (
    <Sheet open={!!target} title={target?.title ?? ""} onClose={onClose}>
      <Fragment key={JSON.stringify(target)}>{form()}</Fragment>
    </Sheet>
  );
}
