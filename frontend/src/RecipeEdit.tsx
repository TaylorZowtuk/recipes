import { type Dispatch, type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { api, type Recipe } from "./api/client";
import { forgetCollection, loadCollection, rememberRecipe } from "./collection";
import {
  changeCount,
  type DeleteOutcome,
  type Draft,
  deleteOutcome,
  draftOperations,
  type EditAction,
  type EditOutcome,
  editOutcome,
  saveLabel,
} from "./editRecipe";
import {
  DifficultyField,
  PAUSED,
  PhotoPicker,
  TagsField,
  useEditBlock,
  useMounted,
} from "./RecipeFields";

// Off while offline or paused, like every edit that isn't queued.
function BlockedNote({ blocked }: { blocked: "offline" | "paused" | null }) {
  if (!blocked) return null;
  return (
    <p className="screen-note">
      {blocked === "offline" ? "You’re offline. Edit the recipe once you’re back online." : PAUSED}
    </p>
  );
}

export function EditButton({ onEdit }: { onEdit: () => void }) {
  const blocked = useEditBlock();
  return (
    <div className="edit-open">
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
  );
}

// Loads the Collection this device just changed, so the page shows the newer recipe at once.
async function reloadCollection() {
  forgetCollection();
  await loadCollection().catch(() => {});
}

// Edit: the draft's Difficulty, Tags and Preview Photo, saved together in one PATCH at the
// recipe's version. Delete removes the recipe after a confirm. A conflict on either reloads the
// Collection and leaves Edit, showing the newer recipe.
export function EditRecipe({
  recipe,
  title,
  draft,
  problem,
  dispatch,
}: {
  recipe: Recipe;
  title: string;
  draft: Draft;
  problem?: string;
  dispatch: Dispatch<EditAction>;
}) {
  const blocked = useEditBlock();
  const mounted = useMounted();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"saving" | "deleting">();
  const count = changeCount(recipe, draft);
  const change = (change: Partial<Draft>) => dispatch({ type: "change", change });

  const settle = async (outcome: EditOutcome | DeleteOutcome) => {
    if (outcome.kind === "saved") rememberRecipe(outcome.recipe);
    if (outcome.kind === "saved" || outcome.kind === "conflict") await reloadCollection();
    if (!mounted.current) return;
    setBusy(undefined);
    dispatch({ type: "settled", outcome });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || count === 0) return;
    const operations = draftOperations(recipe, draft);
    if (!operations) return dispatch({ type: "incomplete" });
    setBusy("saving");
    let outcome: EditOutcome;
    try {
      outcome = editOutcome(
        await api.PATCH("/api/recipes/{recipe_id}", {
          params: { path: { recipe_id: recipe.id } },
          body: { version: recipe.version, operations },
        }),
      );
    } catch {
      outcome = { kind: "failed" };
    }
    await settle(outcome);
  };

  const remove = async () => {
    if (busy || !window.confirm(`Delete “${title}”? This can’t be undone.`)) return;
    setBusy("deleting");
    let outcome: DeleteOutcome;
    try {
      outcome = deleteOutcome(
        await api.DELETE("/api/recipes/{recipe_id}", {
          params: { path: { recipe_id: recipe.id }, query: { version: recipe.version } },
        }),
      );
    } catch {
      outcome = { kind: "failed" };
    }
    if (outcome.kind === "deleted") {
      forgetCollection();
      // Replaced, so Back doesn't return to the deleted recipe.
      return navigate("/recipes", { replace: true });
    }
    await settle(outcome);
  };

  return (
    <form className="review-form edit-form" noValidate onSubmit={save}>
      <fieldset disabled={!!blocked} className="review-fields">
        <PhotoPicker
          title={title}
          images={recipe.images}
          preview={draft.preview}
          onPick={(preview) => change({ preview })}
        />
        <DifficultyField
          difficulty={draft.difficulty}
          onChange={(difficulty) => change({ difficulty })}
        />
        <TagsField tags={draft.tags} onChange={(tags) => change({ tags })} />
      </fieldset>
      <div className="review-actions">
        <button
          type="submit"
          className="button"
          disabled={!!blocked || count === 0}
          aria-disabled={!!busy}
        >
          {busy === "saving" ? "Saving…" : saveLabel(count)}
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
        {busy === "saving" ? "Saving the changes…" : busy === "deleting" ? "Deleting…" : ""}
      </p>
      {problem && (
        <p role="alert" className="form-problem">
          {problem}
        </p>
      )}
      <div className="edit-delete">
        <button
          type="button"
          className="text-button text-button-danger"
          disabled={!!blocked}
          aria-disabled={!!busy}
          onClick={remove}
        >
          Delete recipe
        </button>
      </div>
    </form>
  );
}
