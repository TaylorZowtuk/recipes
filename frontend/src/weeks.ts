import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, type Collection, type WeekOperation, type WeekPlan } from "./api/client";
import { forgetCollection, type Loaded } from "./collection";
import { applyDemoOperations, demoWeek } from "./demoWeek";
import { session } from "./session";
import type { ToastMessage } from "./Toast";
import { isoDate } from "./weekDates";
import { createWeekStore, noticedWrite, writeToast } from "./weekPlan";

// The app's one week store. Week Plans are private to the household's editors, so nothing read
// here outlives the session. A write that names a missing recipe means this device's Collection is
// out of date, so it's forgotten and the picker drops the recipe.
const weeks = createWeekStore(api, forgetCollection);
session.subscribe(() => {
  if (!session.getSnapshot().isEditor) weeks.clear();
});

// The device's local day, which moves on when the window comes back after midnight.
export function useToday(): string {
  const [today, setToday] = useState(() => isoDate(new Date()));
  useEffect(() => {
    const check = () => setToday(isoDate(new Date()));
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  return today;
}

// A week, loaded on mount, when `monday` changes and when the window comes back. Null loads nothing,
// as for a visitor. What's known stays on screen while a reload is under way.
export function useWeek(monday: string | null) {
  const week = useSyncExternalStore(weeks.subscribe, () => weeks.week(monday ?? ""));
  useEffect(() => {
    if (!monday) return;
    const load = () => void weeks.load(monday);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [monday]);
  const retry = useCallback(() => {
    if (monday) void weeks.load(monday);
  }, [monday]);
  return { ...week, retry };
}

// Writes to a week, with the toast saying what went wrong, if anything. `busy` says so for a tap
// that never got as far as a write.
export function useWeekEdit(monday: string) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const edit = (operations: WeekOperation[]) =>
    noticedWrite(() => weeks.write(monday, operations), setToast);
  const busy = useCallback(() => setToast(writeToast({ kind: "busy" })), []);
  const dismiss = useCallback(() => setToast(null), []);
  return { edit, busy, toast, dismiss };
}

// A visitor's changes to the Demo, in memory only, so a reload brings back each week as generated.
const demos = new Map<string, WeekPlan>();
const demoListeners = new Set<() => void>();
const subscribeDemos = (listener: () => void) => {
  demoListeners.add(listener);
  return () => void demoListeners.delete(listener);
};
const noop = () => {};

// The Demo Week Plan, with the same shape as useWeek and useWeekEdit together. It's built on this
// device from the Collection, so nothing is ever sent to the API.
export function useDemoWeek(monday: string, collection: Loaded<Collection>) {
  const edited = useSyncExternalStore(subscribeDemos, () => demos.get(monday));
  const cards = collection.state === "ready" ? collection.value.cards : undefined;
  const generated = useMemo(() => cards && demoWeek(monday, cards), [monday, cards]);
  const plan = edited ?? generated;
  const edit = async (operations: WeekOperation[]) => {
    if (!plan || !cards) return;
    demos.set(monday, applyDemoOperations(plan, operations, cards));
    for (const listener of demoListeners) listener();
  };
  return {
    plan,
    failed: collection.state === "failed",
    writing: false,
    retry: collection.state === "failed" ? collection.retry : noop,
    edit,
    busy: noop,
    toast: null,
    dismiss: noop,
  };
}
