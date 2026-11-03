import { type ReactNode, useEffect, useId, useRef } from "react";
import { formatAmount } from "./amount";
import type { Collection, Recipe } from "./api/client";
import { DifficultyMeters } from "./DifficultyMeters";
import type { Mark, ReviewItem, ReviewTab } from "./review";
import { reviewCounts } from "./needsReview";
import { confirmableOn, tabCounts, uncheckedOn } from "./review";

// What the recipe view needs to show an editor Review Items: each item by id, opening one, and
// the ids of the unconfirmed Canonical Ingredients, whose lines it marks new.
export type ReviewTarget = {
  items: Map<string, ReviewItem>;
  open: (id: string) => void;
  newCanonicals: Set<string>;
};

const MARK_TEXT: Record<Mark, string> = {
  unchecked: "Unchecked",
  flagged: "Flagged",
  confirmed: "Confirmed",
};

// An empty circle, a flag or a tick, which screen readers hear as the word.
export function ReviewMark({ mark, shown = false }: { mark: Mark; shown?: boolean }) {
  return (
    <span className={`review-mark review-mark-${mark}`}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {mark === "unchecked" && <circle cx="8" cy="8" r="6" />}
        {mark === "flagged" && <path d="M4 15V2h8l-2 3.5L12 9H5.5" />}
        {mark === "confirmed" && <path d="M3 8.5l3.2 3.2L13 4.5" />}
      </svg>
      {shown ? MARK_TEXT[mark] : <span className="visually-hidden">{MARK_TEXT[mark]}: </span>}
    </span>
  );
}

// A Review Item as a button that opens its sheet, its mark before what it shows.
export function ReviewButton({
  item,
  review,
  children,
}: {
  item: ReviewItem;
  review: ReviewTarget;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`review-item review-item-${item.mark}`}
      aria-haspopup="dialog"
      onClick={() => review.open(item.id)}
    >
      <ReviewMark mark={item.mark} />
      <span className="review-item-body">{children}</span>
    </button>
  );
}

// Above the tab bar: what is left to check on this tab, flagged items included, counted as the
// card counts them; and Confirm N on this tab, which takes every unchecked item and never a
// flagged one. Nothing shows once the tab is all confirmed.
export function ReviewBar({
  items,
  tab,
  onConfirm,
  disabled = false,
  note,
}: {
  items: Map<string, ReviewItem>;
  tab: ReviewTab;
  onConfirm: (factIds: string[]) => void;
  disabled?: boolean;
  note?: ReactNode;
}) {
  const unchecked = uncheckedOn(items, tab);
  const toCheck = tabCounts(items)[tab];
  if (toCheck === 0) return null;
  const flagged = [...items.values()].filter((i) => i.tab === tab && i.mark === "flagged").length;
  return (
    <div className="review-bar">
      <p className="review-bar-left">
        {reviewCounts({ open_issues: flagged, unconfirmed: toCheck })}
      </p>
      {unchecked.length > 0 ? (
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => onConfirm(confirmableOn(items, tab))}
        >
          Confirm {unchecked.length} on this tab
        </button>
      ) : (
        <p className="review-bar-hint">Tap a flagged item to accept its correction.</p>
      )}
      {note}
    </div>
  );
}

type Stamped = { provenance: string; confidence: number; estimated: boolean };

// Where a fact came from and how sure enrichment was, as raw numbers.
function Source({ fact }: { fact: Stamped }) {
  return (
    <p className="review-source">
      {fact.provenance} · confidence {fact.confidence}
      {fact.estimated && " · estimated"}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sheet-section review-detail">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="review-facts">
      {rows
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

// A line's name as parsed, else as written.
function lineName(recipe: Recipe, lineId: string) {
  return (
    recipe.facts.ingredients[lineId]?.parse?.name ??
    recipe.original.ingredients.find((line) => line.id === lineId)?.text ??
    lineId
  );
}

// Everything enrichment says about a Review Item, for an editor to check before confirming it.
export function ItemDetail({
  item,
  recipe,
  collection,
}: {
  item: ReviewItem;
  recipe: Recipe;
  collection: Pick<Collection, "canonical_ingredients" | "kitchen_settings">;
}) {
  const [owner = ""] = item.id.split(".");
  const line = recipe.facts.ingredients[owner];
  const step = recipe.facts.steps[owner];
  const sections: ReactNode[] = [];
  // Last of all, so it shows just above the sheet's actions rather than scrolled under them.
  let newNote: ReactNode = null;

  // An item an open Enrichment Issue alone makes has no facts of its own to show.
  if (item.id === "difficulty") {
    if (recipe.facts.difficulty)
      sections.push(
      <Section key="difficulty" title="Suggested Difficulty">
        <DifficultyMeters difficulty={recipe.facts.difficulty} suggested />
        <Source fact={recipe.facts.difficulty} />
      </Section>,
    );
  } else if (item.id.endsWith(".substitutions")) {
    if (line?.substitutions)
      sections.push(
      <Section key="substitutions" title="Substitutions">
        <ul className="review-list">
          {line.substitutions.items.map((sub) => (
            <li key={sub.wording}>
              {sub.wording} × {sub.ratio}
              {sub.note && ` · ${sub.note}`}
            </li>
          ))}
        </ul>
        <Source fact={line.substitutions} />
      </Section>,
    );
  } else if (line) {
    const { parse, match, conversion } = line;
    if (parse) {
      sections.push(
        <Section key="parse" title="Parse">
          <Facts
            rows={[
              ["Amount", parse.quantity && formatAmount(parse.quantity, parse.unit)],
              ["Name", parse.name],
              ["Preparation", parse.preparation],
              ["Comment", parse.comment],
              ["Optional", parse.optional ? "Yes" : null],
            ]}
          />
          <Source fact={parse} />
        </Section>,
      );
    }
    if (match) {
      const canonical = collection.canonical_ingredients.find((c) => c.id === match.canonical_id);
      const category = collection.kitchen_settings.store_categories.find(
        (c) => c.id === canonical?.store_category_id,
      );
      sections.push(
        <Section key="match" title="Canonical Ingredient">
          <Facts
            rows={[
              [
                "Name",
                <>
                  {canonical?.name ?? match.canonical_id}
                  {canonical && !canonical.confirmed && <span className="review-new">new</span>}
                </>,
              ],
              ["Family", canonical?.family],
              ["Store Category", category?.name ?? canonical?.store_category_id],
            ]}
          />
          <Source fact={match} />
        </Section>,
      );
      if (canonical && !canonical.confirmed)
        newNote = (
          <p className="review-note">
            {canonical.name} is a new Canonical Ingredient. Confirming adds {canonical.name} for
            every recipe that uses it.
          </p>
        );
    }
    if (conversion) {
      const weight = conversion.refused
        ? `Stays in the written unit: ${conversion.refused}`
        : conversion.density_g_per_ml !== null
          ? `${conversion.density_g_per_ml} g/ml`
          : `${conversion.grams_per_count} g per ${conversion.count_unit ?? "count"}`;
      sections.push(
        <Section key="conversion" title="Weight">
          <p>{weight}</p>
          <Source fact={conversion} />
          <p className="review-source">
            FDC {conversion.fdc_id} · {conversion.dataset} {conversion.release}
          </p>
        </Section>,
      );
    }
  } else if (step) {
    if (step.segments) {
      sections.push(
        <Section key="segments" title="Segments">
          <ul className="review-list">
            {step.segments.segments.map((segment, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a step's segments never reorder.
              <li key={n}>
                {segment.t === "text"
                  ? `“${segment.v}”`
                  : segment.t === "ingredient"
                    ? `“${segment.written}” → ${lineName(recipe, segment.ref)} × ${segment.portion}`
                    : segment.t === "duration"
                      ? `“${segment.written}” → ${segment.low_s}–${segment.high_s} s`
                      : `“${segment.written}” → ${segment.c} °C`}
              </li>
            ))}
          </ul>
          <Source fact={step.segments} />
        </Section>,
      );
    }
    if (step.uses) {
      sections.push(
        <Section key="uses" title="Uses">
          <ul className="review-list">
            {step.uses.uses.map((use) => (
              <li key={use.ref}>
                {lineName(recipe, use.ref)} × {use.portion}
              </li>
            ))}
          </ul>
          <Source fact={step.uses} />
        </Section>,
      );
    }
  }

  return (
    <>
      {sections}
      {item.issues.map((issue) => (
        <Section key={issue.id} title="Enrichment Issue">
          {(issue.before || issue.after) && (
            <p>
              {issue.before ?? "nothing"} → {issue.after ?? "nothing"}
            </p>
          )}
          <p>{issue.reason}</p>
        </Section>
      ))}
      {newNote}
    </>
  );
}

// What a Review Item is called in its sheet's title.
function itemTitle(item: ReviewItem, recipe: Recipe) {
  if (item.id === "difficulty") return "Suggested Difficulty";
  const [owner = ""] = item.id.split(".");
  const line = recipe.original.ingredients.find((l) => l.id === owner);
  if (line)
    return item.id.endsWith(".substitutions") ? `Substitutions for ${line.text}` : line.text;
  return recipe.original.steps.find((s) => s.id === owner)?.text ?? item.id;
}

// The sheet for one Review Item, a modal dialog like the Filters sheet: its detail, then Confirm,
// or Accept correction while flagged. Escape, Close or a tap outside it closes it.
export function ItemSheet({
  item,
  recipe,
  collection,
  disabled,
  note,
  onConfirm,
  onClose,
}: {
  item: ReviewItem | undefined;
  recipe: Recipe;
  collection: Pick<Collection, "canonical_ingredients" | "kitchen_settings">;
  disabled: boolean;
  note?: ReactNode;
  onConfirm: (factIds: string[]) => void;
  onClose: () => void;
}) {
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const downOnBackdrop = useRef(false);
  const shownId = item?.id;

  useEffect(() => {
    if (!shownId || sheet.current?.open) return;
    sheet.current?.showModal();
    title.current?.focus();
  }, [shownId]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop; Escape closes it too.
    <dialog
      ref={sheet}
      className="sheet"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onPointerDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) =>
        downOnBackdrop.current &&
        event.target === event.currentTarget &&
        event.currentTarget.close()
      }
    >
      {item && (
        <div className="sheet-body">
          <h2 ref={title} id={`${id}-title`} className="sheet-title" tabIndex={-1}>
            {itemTitle(item, recipe)}
          </h2>
          <p className="review-sheet-mark">
            <ReviewMark mark={item.mark} shown />
          </p>
          <ItemDetail item={item} recipe={recipe} collection={collection} />
          {note}
          <div className="sheet-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => sheet.current?.close()}
            >
              Close
            </button>
            {item.mark !== "confirmed" && (
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() => {
                  sheet.current?.close();
                  onConfirm(item.factIds);
                }}
              >
                {item.mark === "flagged" ? "Accept correction" : "Confirm"}
              </button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
