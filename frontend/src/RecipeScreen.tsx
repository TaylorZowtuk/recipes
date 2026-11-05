import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { formatAmount } from "./amount";
import type { Collection, Original, ParseFact, Recipe, RecipeFacts } from "./api/client";
import { useCollection, useRecipe } from "./collection";
import { AddToDayButton } from "./DaySheet";
import { DifficultyMeters } from "./DifficultyMeters";
import { DELETED_ELSEWHERE, editing } from "./editRecipe";
import { ClockIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { Plate } from "./Plate";
import { EditButton, focusEditHeading, RecipeEditor } from "./RecipeEditor";
import { PAUSED, useEditBlock, useMounted } from "./RecipeFields";
import { ItemSheet, ReviewBar, ReviewButton, type ReviewTarget } from "./ReviewSheet";
import { byComponent } from "./recipeComponents";
import {
  confirmItems,
  type ReviewOutcome,
  type ReviewTab,
  reviewOf,
  runReview,
  tabCounts,
  undoBatch,
} from "./review";
import { focusTitle, Screen } from "./Screen";
import { EditorOnly, useIsEditor } from "./session";
import { recipePath, slug } from "./slug";
import { formatStatedTime, statedTimeText } from "./statedTime";
import { type DurationPiece, stepText } from "./stepText";
import { Tabs } from "./Tabs";
import { TagList } from "./TagList";
import { Toast, type ToastMessage } from "./Toast";
import { type TimerStart, timers } from "./timers";

// A recipe at /recipes/<id>/<slug>. The id finds it; a stale or missing slug is corrected in place.
// The header comes from the recipe's card, so it shows as soon as the Collection has loaded. One
// status note stays mounted through every state, so focus can rest on it after a retry. The hero
// shows the Difficulty and every Tag above the tabs, and to an editor an Edit button that swaps the
// tabs for the Edit form. Keyed by the recipe, so a Draft never carries over to another one.
export function RecipeScreen() {
  const { id } = useParams();
  return <RecipePage key={id} />;
}

function RecipePage() {
  const { id, slug: shownSlug } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const collection = useCollection();
  const card =
    collection.state === "ready" ? collection.value.cards.find((c) => c.id === id) : undefined;
  const recipe = useRecipe(card);
  const status = useRef<HTMLParagraphElement>(null);
  const [edit, dispatch] = useReducer(editing, { draft: null });
  const { draft } = edit;
  const ready = card && recipe.state === "ready" ? recipe.value : undefined;

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

  useEffect(() => {
    if (card && shownSlug !== slug(card.title))
      navigate({ pathname: recipePath(card), hash }, { replace: true });
  }, [card, shownSlug, hash, navigate]);

  const missing = collection.state === "ready" && !card;
  const loading = collection.state === "loading" || (card && recipe.state === "loading");
  const gone = card && recipe.state === "failed" && recipe.notFound;
  const failed =
    collection.state === "failed"
      ? collection
      : card && recipe.state === "failed" && !recipe.notFound
        ? recipe
        : undefined;
  const time = card && formatStatedTime(card.stated_seconds);

  return (
    <Screen
      title={card?.title ?? (missing ? "Recipe not found" : "Recipe")}
      pushed
      hero={
        card
          ? {
              above: (
                <>
                  <Plate
                    title={card.title}
                    size="hero"
                    preview={draft ? draft.preview : card.preview}
                  />
                  {card.site_name && <p className="hero-site">{card.site_name}</p>}
                </>
              ),
              below: (
                <>
                  {time && (
                    <p className="hero-time">
                      <ClockIcon />
                      {time}
                    </p>
                  )}
                  {!draft && (
                    <>
                      <DifficultyMeters
                        difficulty={card.difficulty}
                        suggested={card.difficulty_suggested}
                      />
                      <TagList tags={card.tags} />
                      {ready && (
                        <EditorOnly>
                          <div className="hero-actions">
                            <EditButton onEdit={() => dispatch({ type: "open", recipe: ready })} />
                            <AddToDayButton recipe={card} />
                          </div>
                        </EditorOnly>
                      )}
                    </>
                  )}
                </>
              ),
            }
          : {}
      }
    >
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {loading && "Loading the recipe…"}
        {gone && "This recipe is no longer in the Collection."}
        {missing && !edit.notice && "There’s no recipe at this address."}
      </p>
      {failed && <LoadFailed what="The recipe" retry={failed.retry} status={status} />}
      {missing && (
        <p className="screen-note">
          <Link to="/recipes">Browse the Collection</Link>
        </p>
      )}
      {edit.notice && (
        <p ref={notice} role="alert" tabIndex={-1} className="screen-note">
          {missing ? DELETED_ELSEWHERE : edit.notice}
        </p>
      )}
      {card && ready && draft && (
        <RecipeEditor
          recipe={ready}
          title={card.title}
          draft={draft}
          problem={edit.problem}
          dispatch={dispatch}
        />
      )}
      {card && recipe.state === "ready" && !draft && collection.state === "ready" && (
        <RecipeTabs
          recipe={recipe.value}
          collection={collection.value}
          newerLoading={!!recipe.newerLoading}
        />
      )}
    </Screen>
  );
}

// The selected tab, where focus goes when the control that had it is gone.
const focusSelectedTab = () =>
  document
    .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    ?.focus({ preventScroll: true });

const BLOCKED_REVIEW = "You’re offline. Review the recipe once you’re back online.";
const UNDO_OFFLINE = "You’re offline. Undo once you’re back online.";
const STEPS_TAB = 1;

// The Ingredients, Steps and About tabs. To an editor, each tab counts what is left to check on
// it, its Review Items are marked buttons that open their sheet, and a review bar confirms the
// tab's unchecked items. Every confirm shows a toast with Undo; writes are never queued.
function RecipeTabs({
  recipe,
  collection,
  newerLoading,
}: {
  recipe: Recipe;
  collection: Collection;
  newerLoading: boolean;
}) {
  const isEditor = useIsEditor();
  const blocked = useEditBlock();
  const mounted = useMounted();
  const [openId, setOpenId] = useState<string>();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const location = useLocation();
  const jump = location.hash.startsWith("#step-") ? location.hash.slice(1) : undefined;
  const items = isEditor ? reviewOf(recipe) : undefined;
  const counts = items && tabCounts(items);
  const review: ReviewTarget | undefined = items && {
    items,
    newCanonicals: new Set(
      collection.canonical_ingredients.filter((c) => !c.confirmed).map((c) => c.id),
    ),
    open: (id) => {
      opener.current = document.activeElement as HTMLElement | null;
      setOpenId(id);
    },
  };

  // A jump to a step, on every navigation to it, even a repeat of the same address: Tabs has shown
  // the step by now, and focus goes with the view so the next Tab press carries on from there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key tells one jump from the next.
  useEffect(() => {
    const step = jump && document.getElementById(jump);
    if (!step) return;
    step.focus({ preventScroll: true });
    step.scrollIntoView({ block: "center" });
  }, [jump, location.key]);

  // A review write disables the control that started it, which drops its focus, and can remove
  // it (Confirm N on this tab once nothing is left unchecked, Undo once undone), even when the
  // newer recipe arrives later. Until its toast goes, focus that falls to the page returns to
  // that control while it's there and enabled, else moves to the selected tab.
  const refocus = useRef(false);
  const starter = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked whenever what's shown changes.
  useEffect(() => {
    const active = document.activeElement;
    if (!refocus.current || busy || (active && active !== document.body && active.isConnected))
      return;
    const control = starter.current;
    if (control?.isConnected && !control.matches(":disabled")) control.focus();
    else focusSelectedTab();
  }, [recipe, toast, busy]);

  const write = async (run: () => Promise<ReviewOutcome>, retry?: string) => {
    if (busy) return;
    refocus.current = true;
    starter.current = document.activeElement as HTMLElement | null;
    setBusy(true);
    const shown = await runReview(run, retry);
    if (!mounted.current) return;
    setBusy(false);
    setToast(shown);
  };
  const confirm = (factIds: string[]) => write(() => confirmItems(recipe, factIds));
  const done = useCallback(() => {
    refocus.current = false;
    setToast(null);
  }, []);
  // Writes wait for the newer version too, or they'd be refused as made at an old one.
  const off = !!blocked || busy || newerLoading;
  const note = blocked && (
    <p className="screen-note">{blocked === "offline" ? BLOCKED_REVIEW : PAUSED}</p>
  );
  const bar = (tab: ReviewTab) =>
    items && <ReviewBar items={items} tab={tab} disabled={off} note={note} onConfirm={confirm} />;

  return (
    <>
      <Tabs
        label="Recipe"
        reveal={jump ? { tab: STEPS_TAB, key: location.key } : undefined}
        tabs={[
          {
            label: "Ingredients",
            count: counts?.ingredients,
            panel: (
              <>
                <Ingredients original={recipe.original} facts={recipe.facts} review={review} />
                {bar("ingredients")}
              </>
            ),
          },
          {
            label: "Steps",
            count: counts?.steps,
            panel: (
              <>
                <Steps
                  recipeId={recipe.id}
                  original={recipe.original}
                  facts={recipe.facts}
                  review={review}
                />
                {bar("steps")}
              </>
            ),
          },
          {
            label: "About",
            count: counts?.about,
            panel: (
              <>
                <About recipe={recipe} review={review} />
                {bar("about")}
              </>
            ),
          },
        ]}
      />
      {items && (
        <>
          <ItemSheet
            item={openId ? items.get(openId) : undefined}
            recipe={recipe}
            collection={collection}
            disabled={off}
            note={note}
            onConfirm={confirm}
            onClose={() => {
              setOpenId(undefined);
              if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
              else focusSelectedTab();
            }}
          />
          <Toast
            toast={toast}
            disabled={off}
            why={blocked ? (blocked === "offline" ? UNDO_OFFLINE : PAUSED) : undefined}
            onDone={done}
            onUndo={(batch) => write(() => undoBatch(recipe, batch), batch)}
          />
        </>
      )}
    </>
  );
}

// The ingredient lines under a heading wherever the Component changes. A line with a parse fact
// shows its name and preparation with the amount beside them; one without shows its raw text. To
// an editor, a line with facts is a marked Review Item, and the substitutions follow the lines.
export function Ingredients({
  original,
  facts,
  review,
}: {
  original: Original;
  facts?: RecipeFacts;
  review?: ReviewTarget;
}) {
  const parts = byComponent(original.ingredients).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ul className="ingredients">
        {part.lines.map((line) => {
          const { parse, match } = facts?.ingredients[line.id] ?? {};
          const item = review?.items.get(line.id);
          const isNew = !!(item && match && review?.newCanonicals.has(match.canonical_id));
          const shown = parse ? <ParsedLine parse={parse} isNew={isNew} /> : line.text;
          return (
            <li key={line.id}>
              {item && review ? (
                <ReviewButton item={item} review={review}>
                  {shown}
                </ReviewButton>
              ) : (
                shown
              )}
            </li>
          );
        })}
      </ul>
    </section>
  ));
  if (!review || !facts) return parts;
  return (
    <>
      {parts}
      <Substitutions original={original} facts={facts} review={review} />
    </>
  );
}

// Only an editor sees substitutions, for review: nobody else does until they're confirmed.
function Substitutions({
  original,
  facts,
  review,
}: {
  original: Original;
  facts: RecipeFacts;
  review: ReviewTarget;
}) {
  const lines = original.ingredients.filter((line) => review.items.has(`${line.id}.substitutions`));
  if (lines.length === 0) return null;
  return (
    <section className="component review-substitutions">
      <h2>
        Substitutions <span className="review-hidden-note">hidden until confirmed</span>
      </h2>
      <ul className="ingredients">
        {lines.map((line) => {
          const item = review.items.get(`${line.id}.substitutions`);
          const subs = facts.ingredients[line.id]?.substitutions?.items ?? [];
          const name = facts.ingredients[line.id]?.parse?.name ?? line.text;
          return (
            item && (
              <li key={line.id}>
                <ReviewButton item={item} review={review}>
                  <span className="ingredient-name">
                    {subs.length
                      ? subs.map((sub) => `${sub.wording} ≈ ×${sub.ratio}`).join(", ")
                      : "No substitutions suggested"}
                    <span className="ingredient-prep"> for {name}</span>
                  </span>
                </ReviewButton>
              </li>
            )
          );
        })}
      </ul>
    </section>
  );
}

// `isNew` marks, for an editor, a line matched to a Canonical Ingredient not yet confirmed.
function ParsedLine({ parse, isNew = false }: { parse: ParseFact; isNew?: boolean }) {
  const amount = parse.quantity && formatAmount(parse.quantity, parse.unit);
  // The preparation and the line's remark follow the name, as in "garlic, minced, to taste".
  const remarks = [parse.preparation, parse.comment].filter(Boolean).join(", ");
  return (
    <>
      <span className="ingredient-name">
        {parse.name}
        {remarks && <span className="ingredient-prep">, {remarks}</span>}
        {isNew && <span className="review-new">new</span>}
      </span>
      {/* The space is invisible in the flex row, but copied text reads "tahini 3 tbsp". */}
      {amount && (
        <>
          {" "}
          <span className="ingredient-amount">{amount}</span>
        </>
      )}
    </>
  );
}

// The steps, numbered through the whole recipe across its Components. Where a step names an
// ingredient line, it shows the amount that step uses, marked so it can be told apart. A duration
// is a button that starts its Timer. In a Review Item, itself a button, it stays text and the
// buttons follow in a row. A captured recipe has no `recipeId` yet, so no Timers.
export function Steps({
  recipeId,
  original,
  facts,
  review,
}: {
  recipeId?: string;
  original: Original;
  facts?: RecipeFacts;
  review?: ReviewTarget;
}) {
  return byComponent(original.steps).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ol className="steps" start={part.start}>
        {part.lines.map((step, index) => {
          const item = review?.items.get(step.id);
          const timer = (piece: DurationPiece, n: number) =>
            recipeId && (
              <TimerButton
                key={n}
                start={{
                  recipeId,
                  recipeTitle: original.title,
                  stepId: step.id,
                  stepNumber: part.start + index,
                  position: n,
                  written: piece.written,
                  lowS: piece.low_s,
                  highS: piece.high_s,
                }}
              />
            );
          const pieces = stepText(step, facts, 1);
          const shown = pieces.map((piece, n) => {
            if (typeof piece === "string") return piece;
            if ("t" in piece) return (!item && timer(piece, n)) || piece.written;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a step's pieces never reorder.
              <Fragment key={n}>
                <span className="step-amount">{piece.amount}</span> {piece.name}
              </Fragment>
            );
          });
          const timerRow = pieces.flatMap((piece, n) =>
            typeof piece !== "string" && "t" in piece ? (timer(piece, n) ?? []) : [],
          );
          return (
            <li key={step.id} id={`step-${step.id}`} tabIndex={-1}>
              {item && review ? (
                <>
                  <ReviewButton item={item} review={review}>
                    {shown}
                  </ReviewButton>
                  {timerRow.length > 0 && (
                    <div className="step-timers">
                      <ClockIcon />
                      {timerRow}
                    </div>
                  )}
                </>
              ) : (
                shown
              )}
            </li>
          );
        })}
      </ol>
    </section>
  ));
}

function TimerButton({ start }: { start: TimerStart }) {
  return (
    <button
      type="button"
      className="step-timer"
      aria-label={`Start a timer for ${start.written}`}
      onClick={() => timers.start(start)}
    >
      {start.written}
    </button>
  );
}

// The Stated Times (an ISO duration humanized, other text as written) and the yield as written.
export function Facts({ original }: { original: Original }) {
  const { stated_times: times, yield: recipeYield } = original;
  const time = (stated: { text: string } | null) => stated && statedTimeText(stated.text);
  const facts = [
    ["Prep", time(times.prep)],
    ["Cook", time(times.cook)],
    ["Total", time(times.total)],
    ["Yield", recipeYield?.text],
  ].filter((fact): fact is [string, string] => !!fact[1]);
  if (facts.length === 0) return null;
  return (
    <dl className="facts">
      {facts.map(([term, text]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

// The Stated Times and yield, and a link back to the Source. To an editor, enrichment's Suggested
// Difficulty too, as a Review Item.
function About({ recipe, review }: { recipe: Recipe; review?: ReviewTarget }) {
  const { source } = recipe;
  const sourceName = source.kind === "website" ? source.site_name : source.entry_name;
  const suggestion = review?.items.get("difficulty");

  return (
    <>
      {suggestion && review && (
        <section className="component">
          <h2>Suggested Difficulty</h2>
          <ReviewButton item={suggestion} review={review}>
            {/* An open Enrichment Issue alone makes the item when there's no suggestion. */}
            {recipe.facts.difficulty ? (
              <DifficultyMeters difficulty={recipe.facts.difficulty} suggested />
            ) : (
              "No Difficulty suggested"
            )}
          </ReviewButton>
        </section>
      )}
      <Facts original={recipe.original} />
      <p className="source">
        <span>Source</span>
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          {sourceName}
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </p>
    </>
  );
}
