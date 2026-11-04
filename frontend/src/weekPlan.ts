import type { createApi, Factor, WeekOperation, WeekPlan } from "./api/client";
import type { ToastMessage } from "./Toast";
import { DAY_NAMES } from "./weekDates";
import { type Answer, apiError, type WriteRefusal, writeRefusal } from "./writeOutcome";

export const SCALES: Factor[] = [0.5, 1, 1.5, 2, 3];
const SCALE_LABELS: Record<Factor, string> = { 0.5: "½×", 1: "1×", 1.5: "1½×", 2: "2×", 3: "3×" };

export const scaleLabel = (factor: Factor) => SCALE_LABELS[factor];

export const CHANGED_ELSEWHERE =
  "This Week Plan changed on another device. Showing the newer version.";
export const CHANGED_NOT_REFRESHED =
  "This Week Plan changed on another device, but couldn’t refresh. Reload to see the newer version.";
export const RECIPE_GONE = "That recipe is no longer here, so nothing changed.";
export const RECIPE_GONE_NOT_REFRESHED = `${RECIPE_GONE} Reload to see the latest Week Plan.`;
const NOT_AN_EDITOR = "Only the household’s editors can change the Week Plan. Sign in again.";
const UNREACHABLE = "Couldn’t reach Plateful. Try again.";
export const STILL_SAVING = "Still saving. Tap again in a moment.";

// How long a week stays busy after a save. The save moves what's on screen, so the second tap of a
// double-tap would otherwise land on the next entry, or take back what the first placed.
const SETTLE_MS = 300;

// The days a recipe is planned for, as a card shows them: "✓ Wed, Fri".
export function plannedLabel(plan: WeekPlan | undefined, recipeId: string): string | undefined {
  const days = DAY_NAMES.filter((_, day) => onDay(plan, day, recipeId));
  return days.length > 0 ? `✓ ${days.join(", ")}` : undefined;
}

export const onDay = (plan: WeekPlan | undefined, day: number, recipeId: string) =>
  !!plan?.days[day]?.some((entry) => entry.recipe_id === recipeId);

// What choosing a day in the day sheet does: places the recipe, or takes it off that day.
export function dayOperations(plan: WeekPlan, day: number, recipeId: string): WeekOperation[] {
  if (!onDay(plan, day, recipeId)) return [{ op: "place", day, recipe_id: recipeId }];
  return (plan.days[day] ?? [])
    .filter((entry) => entry.recipe_id === recipeId)
    .map((entry) => ({ op: "remove", entry_id: entry.entry_id }));
}

// A day row's accessible name: what a tap does to the recipe on that day.
export function dayRowName(
  title: string,
  day: string,
  { on, past }: { on: boolean; past: boolean },
): string {
  if (on) return `Remove ${title} from ${day}`;
  return past ? `Log ${title} on ${day}` : `Add ${title} to ${day}`;
}

// `skipped`: the week has no plan, or the session ended before the answer came. `busy`: nothing was
// sent, as another write holds the week. `gone`: a recipe or entry the write named no longer
// exists. `refreshed` says whether the week reloaded after a conflict or `gone`, so the notice never
// claims what isn't on screen.
export type WeekWrite =
  | { kind: "saved" | "skipped" | "busy" }
  | { kind: "conflict" | "gone"; refreshed: boolean }
  | { kind: "not-an-editor" | "failed" };

export function writeNotice(outcome: WeekWrite): string | undefined {
  switch (outcome.kind) {
    case "conflict":
      return outcome.refreshed ? CHANGED_ELSEWHERE : CHANGED_NOT_REFRESHED;
    case "gone":
      return outcome.refreshed ? RECIPE_GONE : RECIPE_GONE_NOT_REFRESHED;
    case "not-an-editor":
      return NOT_AN_EDITOR;
    case "failed":
      return UNREACHABLE;
    case "busy":
      return STILL_SAVING;
    default:
      return undefined;
  }
}

export function writeToast(outcome: WeekWrite): ToastMessage | null {
  const text = writeNotice(outcome);
  return text ? { text, brief: outcome.kind === "busy" } : null;
}

// Runs a write, showing what became of it. The last notice goes as the tap lands, not when the write
// answers, so a write that succeeds leaves alone the notice of a tap refused meanwhile.
export async function noticedWrite(
  write: () => Promise<WeekWrite>,
  show: (toast: ToastMessage | null) => void,
) {
  show(null);
  const toast = writeToast(await write());
  if (toast) show(toast);
}

// A stale version is a 409, so a 404 from the API means the write named a recipe or entry that
// doesn't exist at the current version.
function weekRefusal(answer: Answer<WeekPlan>): { kind: "gone" } | WriteRefusal {
  return answer.response.status === 404 && apiError(answer.error)
    ? { kind: "gone" }
    : writeRefusal(answer);
}

const newer = (held: WeekPlan | undefined, plan: WeekPlan) =>
  held && held.version > plan.version ? held : plan;

// A week as this device knows it. `writing` also covers the reload after a conflict and the pause
// after a save.
export type WeekState = { plan?: WeekPlan; failed: boolean; writing: boolean };

const UNKNOWN: WeekState = { failed: false, writing: false };

// The weeks read in this session, in memory only, shared so a card, the day sheet and the Week tab
// agree. One write at a time per week, at the version last read, so a rapid second tap can't go out
// stale. `clear` ends the session's weeks: nothing in flight can bring them back. `onGone` hears of
// a write refused for naming what no longer exists.
export function createWeekStore(api: ReturnType<typeof createApi>, onGone: () => void) {
  const weeks = new Map<string, WeekState>();
  const reads = new Map<string, Promise<boolean>>();
  const listeners = new Set<() => void>();
  let session = 0;

  const week = (monday: string) => weeks.get(monday) ?? UNKNOWN;
  const update = (monday: string, change: Partial<WeekState>) => {
    weeks.set(monday, { ...week(monday), ...change });
    for (const listener of listeners) listener();
  };

  // Says whether the plan arrived. A read and a write can answer in either order, so an older
  // version never replaces a newer one.
  async function read(monday: string): Promise<boolean> {
    const began = session;
    let plan: WeekPlan | undefined;
    try {
      ({ data: plan } = await api.GET("/api/weeks/{monday}", { params: { path: { monday } } }));
    } catch {
      // Offline: reported below, like a refusal.
    }
    if (began !== session) return false;
    if (!plan) update(monday, { failed: true });
    else update(monday, { failed: false, plan: newer(week(monday).plan, plan) });
    return !!plan;
  }

  async function load(monday: string): Promise<void> {
    const joined = reads.get(monday);
    if (joined) return void (await joined);
    if (week(monday).failed) update(monday, { failed: false });
    const current = read(monday);
    reads.set(monday, current);
    await current;
    if (reads.get(monday) === current) reads.delete(monday);
  }

  async function write(monday: string, operations: WeekOperation[]): Promise<WeekWrite> {
    const { plan, writing } = week(monday);
    if (!plan) return { kind: "skipped" };
    if (writing) return { kind: "busy" };
    const began = session;
    update(monday, { writing: true });
    let answer: Answer<WeekPlan> | undefined;
    try {
      answer = await api.PATCH("/api/weeks/{monday}", {
        params: { path: { monday } },
        body: { version: plan.version, operations },
      });
    } catch {
      // Offline: reported below as a failed write.
    }
    if (began !== session) return { kind: "skipped" };
    if (answer?.response.status === 200 && answer.data) {
      update(monday, { plan: newer(week(monday).plan, answer.data) });
      setTimeout(() => {
        if (began === session) update(monday, { writing: false });
      }, SETTLE_MS);
      return { kind: "saved" };
    }
    const refusal = answer ? weekRefusal(answer) : ({ kind: "failed" } as const);
    if (refusal.kind === "gone") onGone();
    const outcome: WeekWrite =
      refusal.kind === "conflict" || refusal.kind === "gone"
        ? { kind: refusal.kind, refreshed: await read(monday) }
        : { kind: refusal.kind };
    if (began !== session) return { kind: "skipped" };
    update(monday, { writing: false });
    return outcome;
  }

  return {
    week,
    load,
    write,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    clear() {
      session++;
      weeks.clear();
      reads.clear();
      for (const listener of listeners) listener();
    },
  };
}
