import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { AdjustButton } from "./AdjustSheet";
import { type AdjustChoices, AS_WRITTEN, type LineView, lineView, type UnitChoice } from "./adjust";
import type { Collection, Factor, Original, ParseFact, Recipe, RecipeFacts } from "./api/client";
import { CookButton, type Cooking, CookingMode } from "./CookingMode";
import { useCollection, useRecipe } from "./collection";
import { AddToDayButton } from "./DaySheet";
import { DifficultyMeters } from "./DifficultyMeters";
import { DELETED_ELSEWHERE, editing } from "./editRecipe";
import { CheckIcon, ClockIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import {
  type EffectiveLine,
  type EffectiveOriginal,
  effective,
  lineNote,
  stepNote,
} from "./ourVersion";
import { Plate } from "./Plate";
import { EditButton, focusEditHeading, RecipeEditor } from "./RecipeEditor";
import { PAUSED, useEditBlock, useMounted } from "./RecipeFields";
import { ItemSheet, ReviewBar, ReviewButton, type ReviewTarget } from "./ReviewSheet";
import { byComponent } from "./recipeComponents";
import {
  confirmItems,
  type FactEdit,
  type ReviewOutcome,
  type ReviewTab,
  reviewOf,
  runEdit,
  runReview,
  shownItem,
  tabCounts,
  undoBatch,
} from "./review";
import { focusTitle, hashTookFocus, Screen } from "./Screen";
import { stepNodes, TimerButton } from "./StepPieces";
import { EditorOnly, useIsEditor } from "./session";
import { recipePath, slug } from "./slug";
import { formatStatedTime, statedTimeText } from "./statedTime";
import { type DurationPiece, stepText } from "./stepText";
import { stepTicks, useStepTicks } from "./stepTicks";
import { Tabs } from "./Tabs";
import { TagList } from "./TagList";
import { Toast, type ToastMessage } from "./Toast";
import { timers } from "./timers";
import { SCALES } from "./weekPlan";

// A recipe at /recipes/<id>/<slug>. The id finds it; a stale or missing slug is corrected in place.
// The header comes from the recipe's card, so it shows as soon as the Collection has loaded. One
// status note stays mounted through every state, so focus can rest on it after a retry. The hero
// shows the Difficulty and every Tag above the tabs, and to an editor an Edit button that swaps the
// tabs for the Edit form. Keyed by the recipe, so a Draft never carries over to another one.
const FINISH_EDITING = "Finish editing to see this step.";

// The scale a link asks for (`?scale=1.5`, as a Week Plan day's links do), if it's one of the scales.
function linkedScale(search: string): Factor {
  const asked = Number(new URLSearchParams(search).get("scale"));
  return SCALES.find((factor) => factor === asked) ?? 1;
}

export function RecipeScreen() {
  const { id } = useParams();
  return <RecipePage key={id} />;
}

function RecipePage() {
  const { id, slug: shownSlug } = useParams();
  const navigate = useNavigate();
  const { hash, key, search } = useLocation();
  const collection = useCollection();
  const card =
    collection.state === "ready" ? collection.value.cards.find((c) => c.id === id) : undefined;
  const recipe = useRecipe(card);
  const status = useRef<HTMLParagraphElement>(null);
  const [edit, dispatch] = useReducer(editing, { draft: null });
  const { draft } = edit;
  const ready = card && recipe.state === "ready" ? recipe.value : undefined;
  // A Pending recipe has no Facts, so nothing on it scales or converts: it shows as written.
  const pending = recipe.state === "ready" && recipe.value.status === "pending";
  // The Adjust choices live only here, on this device, so they go when the recipe does.
  const [choices, setChoices] = useState<AdjustChoices>(() => ({
    scale: linkedScale(search),
    units: "written",
  }));
  // Cooking mode lives here, not in the hero, so it stays open on what it opened with while the
  // page can't show the recipe: a newer version that failed to load, or the card gone.
  const [cooking, setCooking] = useState<Cooking | null>(null);
  const cookOpener = useRef<HTMLButtonElement>(null);

  // Focus moves with Edit, since the control that had it is gone: entering it, to the form's
  // heading; leaving it, to the notice saying why Edit closed if there is one, else the title. A
  // step in the address has shown itself and taken focus by then: it keeps focus, to match the
  // view, unless there's a notice, which then scrolls into view.
  const notice = useRef<HTMLParagraphElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (!wasEditing.current && draft) focusEditHeading();
    if (wasEditing.current && !draft) {
      const stepShown = hashTookFocus(hash);
      if (notice.current) notice.current.focus({ preventScroll: !stepShown });
      else if (!stepShown) focusTitle();
    }
    wasEditing.current = !!draft;
  }, [draft, hash]);

  // Edit keeps the Draft on screen, so a jump tapped during it can't show its step yet. Only a new
  // navigation says so: a step jumped to before Edit opened is still in the address.
  const shownKey = useRef(key);
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    if (draft && hash.startsWith("#step-")) timers.notify(FINISH_EDITING);
  }, [key, draft, hash]);

  // A renamed recipe's address takes its new slug in place, marked so Cooking mode doesn't take the
  // step in it for a new jump.
  useEffect(() => {
    if (card && shownSlug !== slug(card.title))
      navigate(
        { pathname: recipePath(card), search, hash },
        { replace: true, state: { slugFixed: true } },
      );
  }, [card, shownSlug, search, hash, navigate]);

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
                        <div className="hero-actions">
                          <AdjustButton
                            choices={choices}
                            onChange={setChoices}
                            pending={pending}
                            ourVersion={!!ready.our_version}
                          />
                          <CookButton
                            recipe={ready}
                            version={choices.version ?? "ours"}
                            opener={cookOpener}
                            onCook={() =>
                              setCooking({ recipe: ready, choices: pending ? AS_WRITTEN : choices })
                            }
                          />
                          <EditorOnly>
                            <EditButton onEdit={() => dispatch({ type: "open", recipe: ready })} />
                            <AddToDayButton recipe={card} />
                          </EditorOnly>
                        </div>
                      )}
                    </>
                  )}
                </>
              ),
            }
          : {}
      }
    >
      {cooking && (
        <CookingMode
          {...cooking}
          opener={cookOpener}
          fallback={status}
          onClose={() => setCooking(null)}
        />
      )}
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {loading && "Loading the recipe…"}
        {gone && "This recipe is no longer in the Collection."}
        {missing && !edit.notice && "There’s no recipe at this address."}
      </p>
      {failed && (
        <LoadFailed
          what="The recipe"
          offline={failed.offline}
          retry={failed.retry}
          status={status}
        />
      )}
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
      {card && ready && draft && collection.state === "ready" && (
        <RecipeEditor
          recipe={ready}
          title={card.title}
          collection={collection.value}
          draft={draft}
          problem={edit.problem}
          refusedAt={edit.at}
          dispatch={dispatch}
        />
      )}
      {card && recipe.state === "ready" && !draft && collection.state === "ready" && (
        <RecipeTabs
          recipe={recipe.value}
          collection={collection.value}
          newerLoading={!!recipe.newerLoading}
          choices={pending ? AS_WRITTEN : choices}
          onTap={(lineId, unit) =>
            setChoices((shown) => ({ ...shown, taps: { ...shown.taps, [lineId]: unit } }))
          }
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
  choices,
  onTap,
}: {
  recipe: Recipe;
  collection: Collection;
  newerLoading: boolean;
  choices: AdjustChoices;
  onTap: (lineId: string, unit: UnitChoice) => void;
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
  const ticks = useStepTicks(recipe.id);
  const items = isEditor ? reviewOf(recipe) : undefined;
  const version = choices.version ?? "ours";
  const shown = effective(recipe, version);
  const counts = items && tabCounts(items);
  const review: ReviewTarget | undefined = items && {
    items,
    ours: version === "ours" && !!recipe.our_version,
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
  const closeSheet = () => {
    setOpenId(undefined);
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    else focusSelectedTab();
  };
  // An edit keeps its sheet open until it's saved, or the recipe changed elsewhere, and says in
  // the form why it wasn't saved. Its toast has no Undo: the editor edits again instead.
  const edit = async (change: FactEdit) => {
    if (busy) return null;
    setBusy(true);
    const settled = await runEdit(recipe, change, collection);
    if (!mounted.current) return null;
    setBusy(false);
    if ("problem" in settled) return settled.problem;
    closeSheet();
    refocus.current = true;
    starter.current = document.activeElement as HTMLElement | null;
    setToast(settled.toast);
    return null;
  };
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
                <Ingredients
                  original={shown.original}
                  facts={shown.facts}
                  review={review}
                  choices={choices}
                  onTap={onTap}
                />
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
                  original={shown.original}
                  facts={shown.facts}
                  review={review}
                  choices={choices}
                  ticks={ticks}
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
                <About
                  recipe={recipe}
                  review={review}
                  note={version === "ours" ? recipe.our_version?.note : null}
                />
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
            onEdit={edit}
            onClose={closeSheet}
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
// shows its name and preparation with the amount beside them, with the Adjust choices; one without
// shows its raw text. With `onTap`, an amount with another unit to show is a button that moves it
// on, and one that stays in its unit for want of a weight says why when tapped. To an editor, a
// line with facts is a marked Review Item, its amount plain text, and the substitutions follow the
// lines. In Our Version, an edited or added line says so quietly under it, and is Our Version's
// own Review Item.
export function Ingredients({
  original,
  facts,
  review,
  choices = AS_WRITTEN,
  onTap,
}: {
  original: EffectiveOriginal;
  facts?: RecipeFacts;
  review?: ReviewTarget;
  choices?: AdjustChoices;
  onTap?: (lineId: string, unit: UnitChoice) => void;
}) {
  const parts = byComponent(original.ingredients).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ul className="ingredients">
        {part.lines.map((line) => {
          const lineFacts = facts?.ingredients[line.id];
          const { parse, match } = lineFacts ?? {};
          const item = review && shownItem(review, line.id, !!line.change);
          const note = lineNote(line, lineFacts, choices);
          const isNew = !!(item && match && review?.newCanonicals.has(match.canonical_id));
          const tapped = choices.taps?.[line.id];
          const amount =
            lineFacts &&
            parse?.quantity &&
            (onTap && !review ? (
              <TappableAmount
                view={lineView(lineFacts, choices, tapped)}
                adjusted={`${choices.scale} ${choices.units}`}
                name={parse.name}
                onTap={(unit) => onTap(line.id, unit)}
              />
            ) : (
              <span className="ingredient-amount">
                {lineView(lineFacts, choices, tapped).amount}
              </span>
            ));
          const shown = parse ? (
            <ParsedLine parse={parse} isNew={isNew} amount={amount} />
          ) : (
            line.text
          );
          return (
            <li key={line.id}>
              {item && review ? (
                <ReviewButton item={item} review={review}>
                  {shown}
                </ReviewButton>
              ) : (
                shown
              )}
              {note && <span className="our-version-note">{note}</span>}
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
  original: EffectiveOriginal;
  facts: RecipeFacts;
  review: ReviewTarget;
}) {
  const itemOf = (line: EffectiveLine) =>
    shownItem(review, `${line.id}.substitutions`, !!line.change);
  const lines = original.ingredients.filter((line) => itemOf(line));
  if (lines.length === 0) return null;
  return (
    <section className="component review-substitutions">
      <h2>
        Substitutions <span className="review-hidden-note">hidden until confirmed</span>
      </h2>
      <ul className="ingredients">
        {lines.map((line) => {
          const item = itemOf(line);
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

// An ingredient's amount with the Adjust choices, as a button when a tap shows it in another unit
// (round its units and back), or says why it can't be a weight. A line with neither is plain text.
// After a tap, the amount and any reason are read out politely, and the reason shows, until the
// scale or units (`adjusted`) change. Each tap's text differs from the last, so a repeat is read.
function TappableAmount({
  view: { amount, next, reason },
  adjusted,
  name,
  onTap,
}: {
  view: LineView;
  adjusted: string;
  name: string;
  onTap: (unit: UnitChoice) => void;
}) {
  const [said, setSaid] = useState<{ at: string; taps: number }>({ at: adjusted, taps: 0 });
  if (said.at !== adjusted) setSaid({ at: adjusted, taps: 0 });
  const tapped = said.at === adjusted && said.taps > 0;
  if (!next && !reason) return <span className="ingredient-amount">{amount}</span>;
  return (
    <>
      <button
        type="button"
        className="ingredient-amount ingredient-tap"
        aria-label={`${amount} ${name}, ${next ? "show in another unit" : "why it stays in this unit"}`}
        onClick={() => {
          setSaid({ at: adjusted, taps: said.taps + 1 });
          if (next) onTap(next);
        }}
      >
        {amount}
      </button>
      <span aria-live="polite" aria-atomic="true" className="ingredient-reason">
        {tapped && (
          <>
            <span className="visually-hidden">
              {reason ? `${amount}. ` : amount}
              {said.taps % 2 === 0 && "\u200b"}
            </span>
            {reason && <span className="ingredient-why">{reason}</span>}
          </>
        )}
      </span>
    </>
  );
}

// `isNew` marks, for an editor, a line matched to a Canonical Ingredient not yet confirmed.
function ParsedLine({
  parse,
  isNew = false,
  amount,
}: {
  parse: ParseFact;
  isNew?: boolean;
  amount: ReactNode;
}) {
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
      {amount && <> {amount}</>}
    </>
  );
}

// The steps, numbered through the whole recipe across its Components. Where a step names an
// ingredient line, it shows the amount that step uses, marked so it can be told apart. A duration
// is a button that starts its Timer. In a Review Item, itself a button, it stays text and the
// buttons follow in a row. Under each step's number, its Step tick: a ticked step dims. A captured
// recipe has no `recipeId` yet, so no Timers and no ticks. In Our Version, an edited or added step
// says so under it, and is Our Version's own Review Item, as is an unchanged step an Our Version
// edit flagged.
export function Steps({
  recipeId,
  original,
  facts,
  review,
  choices = AS_WRITTEN,
  ticks = new Set(),
}: {
  recipeId?: string;
  original: EffectiveOriginal;
  facts?: RecipeFacts;
  review?: ReviewTarget;
  choices?: AdjustChoices;
  ticks?: ReadonlySet<string>;
}) {
  return byComponent(original.steps).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ol className="steps" start={part.start}>
        {part.lines.map((step, index) => {
          const item = review && shownItem(review, step.id, !!step.change);
          const note = stepNote(step);
          const timer = (piece: DurationPiece, n: number) =>
            recipeId && (
              <TimerButton
                key={n}
                recipeId={recipeId}
                recipeTitle={original.title}
                step={step}
                number={part.start + index}
                piece={piece}
                n={n}
              />
            );
          const pieces = stepText(step, facts, choices);
          const shown = stepNodes(
            pieces,
            (piece, n) => (!item && timer(piece, n)) || piece.written,
          );
          const timerRow = pieces.flatMap((piece, n) =>
            typeof piece !== "string" && "t" in piece ? (timer(piece, n) ?? []) : [],
          );
          const main =
            item && review ? (
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
            );
          const body = (
            <>
              {main}
              {note && <span className="our-version-note">{note}</span>}
            </>
          );
          if (!recipeId)
            return (
              <li key={step.id} id={`step-${step.id}`} tabIndex={-1}>
                {body}
              </li>
            );
          const number = part.start + index;
          const done = ticks.has(step.id);
          return (
            <li
              key={step.id}
              id={`step-${step.id}`}
              tabIndex={-1}
              className={done ? "step step-ticked" : "step"}
            >
              <div className="step-mark">
                <span className="step-number" aria-hidden="true">
                  {number}
                </span>
                <button
                  type="button"
                  className="step-tick"
                  aria-pressed={done}
                  aria-label={`Step ${number} done`}
                  onClick={() => stepTicks.toggle(recipeId, step.id)}
                >
                  <CheckIcon />
                </button>
              </div>
              <div className="step-body">{body}</div>
            </li>
          );
        })}
      </ol>
    </section>
  ));
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

// The Stated Times and yield, and a link back to the Source. In Our Version, its note first. To an
// editor, enrichment's Suggested Difficulty too, as a Review Item.
function About({
  recipe,
  review,
  note,
}: {
  recipe: Recipe;
  review?: ReviewTarget;
  note?: string | null;
}) {
  const { source } = recipe;
  const sourceName = source.kind === "website" ? source.site_name : source.entry_name;
  const suggestion = review?.items.get("difficulty");

  return (
    <>
      {note && (
        <section className="component">
          <h2>Our Version</h2>
          <p className="our-version-about">{note}</p>
        </section>
      )}
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
