import { useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Factor, WeekPlanEntry } from "./api/client";
import { useCollection } from "./collection";
import { OFFLINE, WeekNav } from "./DaySheet";
import { SearchIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { Plate } from "./Plate";
import { PAUSED, useEditBlock } from "./RecipeFields";
import { Screen } from "./Screen";
import { Sheet } from "./Sheet";
import { useIsEditor } from "./session";
import { recipePath } from "./slug";
import { Toast } from "./Toast";
import { byTitle, titleMatches } from "./titleSearch";
import { addDays, DAY_NAMES, dayLabel, isPast, mondayOf, weekLabel } from "./weekDates";
import { SCALES, scaleLabel } from "./weekPlan";
import { useDemoWeek, useToday, useWeek, useWeekEdit } from "./weeks";

// The Week tab. A visitor gets a Demo instead of the household's Week Plans, and no week is
// requested: Week Plans are the household's.
export function WeekPlanScreen() {
  const editor = useIsEditor();
  return (
    <Screen title="Week Plan">
      {editor ? (
        <WeekPlanner key="household" demo={false} />
      ) : (
        <>
          <div className="demo-banner">
            <div>
              <p>
                <strong>Demo — changes aren’t saved</strong>
              </p>
              <p>Sign in to plan the household’s week.</p>
            </div>
            <Link to="/sign-in" className="button">
              Sign in
            </Link>
          </div>
          <WeekPlanner key="demo" demo />
        </>
      )}
    </Screen>
  );
}

// One week, Monday to Sunday, with ‹ and › to the others. Past days stay editable, since the
// household corrects its record of what it cooked. Writes are never queued, so edits are off while
// offline or paused, except in a Demo, which lives on this device.
function WeekPlanner({ demo }: { demo: boolean }) {
  const today = useToday();
  const [offset, setOffset] = useState(0);
  const monday = addDays(mondayOf(today), offset * 7);
  const collection = useCollection();
  const household = { ...useWeek(demo ? null : monday), ...useWeekEdit(monday) };
  const demoWeek = useDemoWeek(monday, collection);
  const { plan, failed, writing, retry, edit, busy, toast, dismiss } = demo ? demoWeek : household;
  const editBlock = useEditBlock();
  const blocked = demo ? null : editBlock;
  const status = useRef<HTMLParagraphElement>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [scaling, setScaling] = useState<WeekPlanEntry | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // The Collection may still be loading, when only a known absence means the recipe is gone.
  const gone = (recipeId: string) =>
    collection.state === "ready" && !collection.value.cards.some((c) => c.id === recipeId);
  const closeSheets = () => {
    setPicking(null);
    setScaling(null);
    opener.current?.focus();
  };

  return (
    <div className="week-plan">
      <WeekNav monday={monday} today={today} onMove={(weeks) => setOffset(offset + weeks)} />
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {!plan && !failed && "Loading the week…"}
      </p>
      {!plan && failed && <LoadFailed what="The Week Plan" retry={retry} status={status} />}
      {blocked && <p className="screen-note">{blocked === "offline" ? OFFLINE : PAUSED}</p>}
      {plan &&
        DAY_NAMES.map((name, day) => (
          <Day
            key={name}
            monday={monday}
            day={day}
            today={today}
            entries={plan.days[day] ?? []}
            off={!!blocked}
            writing={writing}
            gone={gone}
            onBusy={busy}
            onAdd={(button) => {
              opener.current = button;
              setPicking(day);
            }}
            onScale={(entry, button) => {
              opener.current = button;
              setScaling(entry);
            }}
            onRemove={(entry) => edit([{ op: "remove", entry_id: entry.entry_id }])}
          />
        ))}
      <Sheet
        open={picking !== null}
        title={
          picking !== null && (
            <>
              <span className="sheet-eyebrow">{weekLabel(monday, today)}</span>
              {`Pick a recipe for ${dayLabel(monday, picking)}`}
            </>
          )
        }
        onClose={closeSheets}
      >
        {picking !== null && (
          <RecipePicker
            off={!!blocked}
            onPick={(recipeId) => {
              setPicking(null);
              void edit([{ op: "place", day: picking, recipe_id: recipeId }]);
            }}
            onCancel={closeSheets}
          />
        )}
      </Sheet>
      <Sheet
        open={!!scaling}
        title={
          scaling && (
            <>
              <span className="sheet-eyebrow">Scale</span>
              {scaling.recipe_title}
            </>
          )
        }
        onClose={closeSheets}
      >
        {scaling && (
          <ScaleChoices
            current={scaling.amount.factor}
            onChoose={(factor) => {
              setScaling(null);
              if (factor === scaling.amount.factor) return;
              void edit([
                {
                  op: "set_amount",
                  entry_id: scaling.entry_id,
                  amount: { kind: "scale", factor },
                },
              ]);
            }}
            onCancel={closeSheets}
          />
        )}
      </Sheet>
      <Toast toast={toast} onDone={dismiss} />
    </div>
  );
}

function Day({
  monday,
  day,
  today,
  entries,
  off,
  writing,
  gone,
  onBusy,
  onAdd,
  onScale,
  onRemove,
}: {
  monday: string;
  day: number;
  today: string;
  entries: WeekPlanEntry[];
  off: boolean;
  writing: boolean;
  gone: (recipeId: string) => boolean;
  onBusy: () => void;
  onAdd: (button: HTMLElement) => void;
  onScale: (entry: WeekPlanEntry, button: HTMLElement) => void;
  onRemove: (entry: WeekPlanEntry) => void;
}) {
  const id = useId();
  const add = useRef<HTMLButtonElement>(null);
  const date = addDays(monday, day);
  const isToday = date === today;
  const label = dayLabel(monday, day);
  const kind = isToday ? " week-day-today" : isPast(date, today) ? " week-day-past" : "";

  return (
    <section
      className={`week-day${kind}`}
      aria-labelledby={id}
      aria-current={isToday ? "date" : undefined}
    >
      <div className="week-day-head">
        <h2 id={id}>
          {label}
          {isToday && <span className="week-today"> Today</span>}
        </h2>
        {entries.length === 0 && <span className="week-free">Free</span>}
        <button
          ref={add}
          type="button"
          className="text-button week-add"
          aria-label={`+ Add to ${label}`}
          aria-haspopup="dialog"
          disabled={off}
          aria-disabled={writing}
          onClick={(event) => (writing ? onBusy() : onAdd(event.currentTarget))}
        >
          + Add
        </button>
      </div>
      {entries.length > 0 && (
        <ul className="week-entries">
          {entries.map((entry) => (
            <li key={entry.entry_id}>
              {gone(entry.recipe_id) ? (
                <span className="week-entry-title">{entry.recipe_title}</span>
              ) : (
                <Link
                  className="week-entry-title"
                  to={recipePath({ id: entry.recipe_id, title: entry.recipe_title })}
                >
                  {entry.recipe_title}
                </Link>
              )}
              <button
                type="button"
                className="chip week-scale"
                aria-label={`Scale ${entry.recipe_title}, now ${scaleLabel(entry.amount.factor)}`}
                aria-haspopup="dialog"
                disabled={off}
                aria-disabled={writing}
                onClick={(event) => (writing ? onBusy() : onScale(entry, event.currentTarget))}
              >
                {scaleLabel(entry.amount.factor)}
              </button>
              <button
                type="button"
                className="icon-button week-remove"
                aria-label={`Remove ${entry.recipe_title} from ${label}`}
                disabled={off}
                aria-disabled={writing}
                onClick={() => {
                  if (writing) return onBusy();
                  // The button goes with its entry, so focus moves on first.
                  add.current?.focus();
                  onRemove(entry);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecipePicker({
  off,
  onPick,
  onCancel,
}: {
  off: boolean;
  onPick: (recipeId: string) => void;
  onCancel: () => void;
}) {
  const collection = useCollection();
  const [query, setQuery] = useState("");
  const status = useRef<HTMLParagraphElement>(null);
  const cards = useMemo(
    () => (collection.state === "ready" ? [...collection.value.cards].sort(byTitle) : []),
    [collection],
  );
  const shown = cards.filter((card) => titleMatches(card.title, query));

  return (
    <>
      <search className="search picker-search">
        <SearchIcon />
        <input
          type="search"
          aria-label="Search recipe titles"
          placeholder="Search recipes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </search>
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {collection.state === "loading" && "Loading the Collection…"}
        {collection.state === "ready" && shown.length === 0 && "No recipes match."}
      </p>
      {collection.state === "failed" && (
        <LoadFailed what="The Collection" retry={collection.retry} status={status} />
      )}
      <ul className="picker-list">
        {shown.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              className="picker-row"
              disabled={off}
              onClick={() => onPick(card.id)}
            >
              <Plate title={card.title} size="card" preview={card.preview} />
              <span>{card.title}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function ScaleChoices({
  current,
  onChoose,
  onCancel,
}: {
  current: Factor;
  onChoose: (factor: Factor) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <ul className="chips chips-wrap sheet-section">
        {SCALES.map((factor) => (
          <li key={factor}>
            <button
              type="button"
              className="chip"
              aria-pressed={factor === current}
              onClick={() => onChoose(factor)}
            >
              {scaleLabel(factor)}
            </button>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}
