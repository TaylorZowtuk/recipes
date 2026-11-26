import { type ReactNode, useId, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import type { Card } from "./api/client";
import { useCollection, useRecipes } from "./collection";
import { OFFLINE } from "./DaySheet";
import { type GroceryItem, groceryList } from "./grocery";
import { CheckIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { PAUSED, useEditBlock } from "./RecipeFields";
import { Screen } from "./Screen";
import { useIsEditor } from "./session";
import { recipePath } from "./slug";
import { Toast } from "./Toast";
import { dayLabel, mondayOf, weekLabel, weekSubtitle } from "./weekDates";
import { scaleLabel } from "./weekPlan";
import { useToday, useWeek, useWeekEdit } from "./weeks";

// One week's Grocery List, opened from its Week Plan. Week Plans are the household's, so a visitor
// is asked to sign in instead.
export function GroceryListScreen() {
  const { monday = "" } = useParams();
  const editor = useIsEditor();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday) || mondayOf(monday) !== monday)
    return <Navigate to="/week" replace />;
  return (
    <Screen title="Grocery List" pushed>
      {editor ? (
        <GroceryListBody monday={monday} />
      ) : (
        <div className="screen-note">
          <p>Sign in to see the household’s Grocery List.</p>
          <Link to="/sign-in" className="button">
            Sign in
          </Link>
        </div>
      )}
    </Screen>
  );
}

// The list is computed here from the Week Plan, its Ready recipes and the Kitchen settings. Ticks
// are never queued, so they're off while offline or paused; a tick shows at once and the list
// re-sorts from the plan the API returns.
function GroceryListBody({ monday }: { monday: string }) {
  const today = useToday();
  const { plan, failed, retry } = useWeek(monday);
  const { tick, toast, dismiss } = useWeekEdit(monday);
  const collection = useCollection();
  const blocked = useEditBlock();
  const status = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());

  const loaded = collection.state === "ready" ? collection.value : undefined;
  const planned = new Set(plan?.days.flat().map((entry) => entry.recipe_id));
  const cards = loaded?.cards ?? [];
  const ready: Card[] = cards.filter((c) => c.status === "ready" && planned.has(c.id));
  const recipes = useRecipes(ready);
  const list =
    plan && loaded && recipes.state === "ready"
      ? groceryList(
          plan,
          new Map(recipes.value.map((recipe) => [recipe.id, recipe])),
          loaded.canonical_ingredients,
          loaded.kitchen_settings,
        )
      : undefined;
  const subtitle = weekSubtitle(monday, today);

  const toggle = async (item: GroceryItem) => {
    if (pending.has(item.key)) return;
    const on = !item.ticked;
    setPending((held) => new Map(held).set(item.key, on));
    await tick({ op: on ? "tick" : "untick", tick: item.tick });
    setPending((held) => {
      const next = new Map(held);
      next.delete(item.key);
      return next;
    });
  };

  return (
    <div className="grocery-list">
      <p className="week-label grocery-week">
        <strong>{weekLabel(monday, today)}</strong>
        {subtitle && <span>{subtitle}</span>}
      </p>
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {!list && !failed && collection.state !== "failed" && recipes.state !== "failed"
          ? "Loading the Grocery List…"
          : list && plan?.days.every((day) => day.length === 0) && "Nothing planned this week."}
      </p>
      {!plan && failed && <LoadFailed what="The Week Plan" retry={retry} status={status} />}
      {collection.state === "failed" && (
        <LoadFailed
          what="The Collection"
          offline={collection.offline}
          retry={collection.retry}
          status={status}
        />
      )}
      {plan && recipes.state === "failed" && (
        <LoadFailed
          what="The planned recipes"
          offline={recipes.offline}
          retry={recipes.retry}
          status={status}
        />
      )}
      {list && blocked && <p className="screen-note">{blocked === "offline" ? OFFLINE : PAUSED}</p>}
      {list && list.notReady.length > 0 && (
        <div className="grocery-not-ready">
          <p>Not on the list until they’re Ready:</p>
          <ul>
            {list.notReady.map(({ recipe_id, title }) => (
              <li key={recipe_id}>
                {cards.some((card) => card.id === recipe_id) ? (
                  <Link to={recipePath({ id: recipe_id, title })}>{title}</Link>
                ) : (
                  title
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {list?.categories.map(({ category, items }) => (
        <Category key={category.id ?? "other"} name={category.name}>
          {items.map((item) => (
            <Item
              key={item.key}
              monday={monday}
              item={item}
              ticked={pending.get(item.key) ?? item.ticked}
              off={!!blocked}
              onTick={() => void toggle(item)}
            />
          ))}
        </Category>
      ))}
      <Toast toast={toast} onDone={dismiss} />
    </div>
  );
}

function Category({ name, children }: { name: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="grocery-category" aria-labelledby={id}>
      <h2 id={id}>{name}</h2>
      <ul>{children}</ul>
    </section>
  );
}

// A Grocery Item: its tick, and a tap anywhere else opens each recipe's own amount and day.
function Item({
  monday,
  item,
  ticked,
  off,
  onTick,
}: {
  monday: string;
  item: GroceryItem;
  ticked: boolean;
  off: boolean;
  onTick: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <li className={ticked ? "grocery-item grocery-item-ticked" : "grocery-item"}>
      <button
        type="button"
        className="step-tick grocery-tick"
        aria-pressed={ticked}
        aria-label={`Bought ${item.name}`}
        disabled={off}
        onClick={onTick}
      >
        <CheckIcon />
      </button>
      <button
        type="button"
        className="grocery-item-main"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="grocery-item-name">
          {item.name}
          {item.recipe && " "}
          {item.recipe && (
            <span className="grocery-item-note">
              {item.recipe}
              {item.factor && ` · ${scaleLabel(item.factor)}`}
            </span>
          )}
          {!ticked && item.tickedEarlier && " "}
          {!ticked && item.tickedEarlier && (
            <span className="grocery-item-note">{item.tickedEarlier} ticked earlier</span>
          )}
        </span>
        {item.amount && (
          <>
            {" "}
            <span className="grocery-item-amount">{item.amount}</span>
          </>
        )}
      </button>
      {open && (
        <ul id={id} className="grocery-breakdown">
          {item.breakdown.map((row) => (
            <li key={row.entry_id}>
              <span>
                {row.title} <span className="grocery-item-note">{dayLabel(monday, row.day)}</span>
              </span>{" "}
              <span>{row.amount}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
