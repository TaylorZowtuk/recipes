import { useRef, useState } from "react";
import { BackIcon, ForwardIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { PAUSED, useEditBlock } from "./RecipeFields";
import { Sheet } from "./Sheet";
import { Toast } from "./Toast";
import {
  addDays,
  DAY_NAMES,
  dayLabel,
  isPast,
  mondayOf,
  weekLabel,
  weekSubtitle,
} from "./weekDates";
import { dayOperations, onDay } from "./weekPlan";
import { useToday, useWeek, useWeekEdit } from "./weeks";

export const OFFLINE = "You’re offline. Plan the week once you’re back online.";

// ‹ and › either side of the week's label, on the Week tab and in the day sheet.
export function WeekNav({
  monday,
  today,
  onMove,
}: {
  monday: string;
  today: string;
  onMove: (weeks: number) => void;
}) {
  const subtitle = weekSubtitle(monday, today);
  return (
    <div className="week-nav">
      <button
        type="button"
        className="icon-button"
        aria-label="Previous week"
        onClick={() => onMove(-1)}
      >
        <BackIcon />
      </button>
      <p className="week-label" aria-live="polite">
        <strong>{weekLabel(monday, today)}</strong>
        {subtitle && <span>{subtitle}</span>}
      </p>
      <button
        type="button"
        className="icon-button"
        aria-label="Next week"
        onClick={() => onMove(1)}
      >
        <ForwardIcon />
      </button>
    </div>
  );
}

type PlannedRecipe = { id: string; title: string };

// Which recipe the day sheet is open for, and the control to give focus back to when it closes.
export function useDaySheet() {
  const [recipe, setRecipe] = useState<PlannedRecipe | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  return {
    recipe,
    open(next: PlannedRecipe, button: HTMLElement) {
      opener.current = button;
      setRecipe(next);
    },
    close() {
      setRecipe(null);
      opener.current?.focus();
    },
  };
}

// The sheet that plans one recipe across days, opening at this week. Each tap writes at once and
// the sheet stays open, so several days can be chosen.
export function DaySheet({
  recipe,
  onClose,
}: {
  recipe: PlannedRecipe | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={!!recipe}
      title={
        recipe && (
          <>
            <span className="sheet-eyebrow">Add to a day</span>
            {recipe.title}
          </>
        )
      }
      onClose={onClose}
    >
      {recipe && <DayRows key={recipe.id} recipeId={recipe.id} onDone={onClose} />}
    </Sheet>
  );
}

function DayRows({ recipeId, onDone }: { recipeId: string; onDone: () => void }) {
  const today = useToday();
  const [offset, setOffset] = useState(0);
  const monday = addDays(mondayOf(today), offset * 7);
  const { plan, failed, writing, retry } = useWeek(monday);
  const { edit, toast, dismiss } = useWeekEdit(monday);
  const blocked = useEditBlock();
  const status = useRef<HTMLParagraphElement>(null);

  return (
    <>
      <WeekNav monday={monday} today={today} onMove={(weeks) => setOffset(offset + weeks)} />
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {!plan && !failed && "Loading the week…"}
      </p>
      {!plan && failed && <LoadFailed what="The Week Plan" retry={retry} status={status} />}
      {blocked && <p className="screen-note">{blocked === "offline" ? OFFLINE : PAUSED}</p>}
      {plan && (
        <ul className="day-options">
          {DAY_NAMES.map((name, day) => {
            const on = onDay(plan, day, recipeId);
            const past = isPast(addDays(monday, day), today);
            const titles = plan.days[day]?.map((entry) => entry.recipe_title).join(", ");
            return (
              <li key={name}>
                <button
                  type="button"
                  className={`day-option${on ? " day-option-on" : ""}${past ? " day-option-past" : ""}`}
                  disabled={!!blocked}
                  aria-disabled={writing}
                  onClick={() => void edit(dayOperations(plan, day, recipeId))}
                >
                  <span className="day-option-day">{dayLabel(monday, day)}</span>{" "}
                  <span className="day-option-entries">{titles || "Free"}</span>{" "}
                  <span className="day-option-action">
                    {on ? "✓ Remove" : past ? "Log" : "Add"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onDone}>
          Done
        </button>
      </div>
      {/* In the sheet, as the open dialog covers anything shown on the page behind it. */}
      <Toast toast={toast} onDone={dismiss} />
    </>
  );
}

// "Add to a day" on the recipe page.
export function AddToDayButton({ recipe }: { recipe: PlannedRecipe }) {
  const sheet = useDaySheet();
  return (
    <>
      <button
        type="button"
        className="button"
        aria-haspopup="dialog"
        onClick={(event) => sheet.open(recipe, event.currentTarget)}
      >
        Add to a day
      </button>
      <DaySheet recipe={sheet.recipe} onClose={sheet.close} />
    </>
  );
}
