import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TimerDock } from "./TimerDock";
import type { TimerView } from "./timers";

const shown: { timers: TimerView[]; notice: string | null } = { timers: [], notice: null };
vi.mock("./timers", () => ({ useTimers: () => shown, timers: {} }));

const view = (fields: Partial<TimerView>): TimerView => ({
  id: "r1/s3/1",
  recipeId: "01K7TEST000000000000000001",
  recipeTitle: "Synthetic Test Noodles",
  stepId: "s3",
  stepNumber: 3,
  position: 1,
  written: "8-10 minutes",
  lowS: 480,
  highS: 600,
  phase: "counting",
  paused: false,
  countdown: "Check in 7:59",
  named: "8-10 minutes, step 3 of Synthetic Test Noodles",
  ...fields,
});

function render(timers: TimerView[], notice: string | null = null) {
  shown.timers = timers;
  shown.notice = notice;
  return renderToStaticMarkup(
    <MemoryRouter>
      <TimerDock />
    </MemoryRouter>,
  );
}

const names = (markup: string) =>
  [...markup.matchAll(/aria-label="([^"]+)"/g)].map(([, name]) => name);

describe("TimerDock", () => {
  it("is hidden with no timers, with its status region mounted", () => {
    const markup = render([]);
    expect(markup).toContain('<section class="timer-dock" aria-label="Timers" hidden="">');
    expect(markup).toContain('role="status"');
  });

  it("shows each timer's recipe, step, duration and countdown, linked to its step", () => {
    const markup = render([view({})]);
    expect(markup).toContain(
      'href="/recipes/01K7TEST000000000000000001/synthetic-test-noodles#step-s3"',
    );
    const text = markup.replace(/<[^>]+>/g, " ");
    expect(text).toContain("Synthetic Test Noodles");
    expect(text).toContain("Step 3 · 8-10 minutes");
    expect(text).toContain("Check in 7:59");
  });

  it("names each control for its timer", () => {
    const markup = render([
      view({}),
      view({ id: "r1/s3/3", named: "10 minutes, step 3 of Synthetic Test Noodles" }),
    ]);
    expect(names(markup)).toEqual([
      "Timers",
      "Pause 8-10 minutes, step 3 of Synthetic Test Noodles",
      "+1 minute on 8-10 minutes, step 3 of Synthetic Test Noodles",
      "Cancel 8-10 minutes, step 3 of Synthetic Test Noodles",
      "Pause 10 minutes, step 3 of Synthetic Test Noodles",
      "+1 minute on 10 minutes, step 3 of Synthetic Test Noodles",
      "Cancel 10 minutes, step 3 of Synthetic Test Noodles",
    ]);
  });

  it("offers Resume on a paused timer and says it's paused", () => {
    const markup = render([view({ paused: true })]);
    expect(names(markup)).toContain("Resume 8-10 minutes, step 3 of Synthetic Test Noodles");
    expect(markup).toContain("Paused · Check in 7:59");
  });

  it("marks a chimed row, and offers no pause on an alarming one", () => {
    expect(render([view({ phase: "chimed" })])).toContain("timer-row timer-chimed");
    const alarming = render([view({ phase: "alarming", countdown: "Time’s up" })]);
    expect(alarming).toContain("timer-row timer-alarming");
    expect(names(alarming).filter((name) => name?.startsWith("Pause"))).toEqual([]);
  });

  it("shows its notice in the status region", () => {
    const markup = render([view({})], "The 8-10 minutes timer is already running.");
    expect(markup).toMatch(/role="status"[^>]*>The 8-10 minutes timer is already running\.</);
  });
});
