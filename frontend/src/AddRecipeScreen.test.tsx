import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddRecipeScreen, PastePage, QueuedItem } from "./AddRecipeScreen";
import type { QueuedIngest } from "./api/client";

vi.mock("./collection", () => ({ useSync: () => undefined, forgetCollection: () => {} }));
vi.mock("./session", () => ({
  EditorOnly: ({ children }: { children: React.ReactNode }) => children,
}));
const shown = vi.hoisted(() => ({ online: true }));
vi.mock("./online", () => ({ useOnline: () => shown.online }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./weeks", () => ({}));

const render = (state?: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[{ pathname: "/add", state }]}>
      <AddRecipeScreen />
    </MemoryRouter>,
  );

const needsPage: QueuedIngest = {
  schema_version: 1,
  id: "01K7TEST0000000000000000Q1",
  source: {
    kind: "website",
    url: "https://kitchen.example.com/stew",
    site_name: "Synthetic Kitchen",
    captured_at: "2026-11-01T10:00:00Z",
  },
  dedupe_key: "kitchen.example.com/stew",
  state: "needs_page",
  reason: "robots",
  queued_at: "2026-11-01T10:00:00Z",
};

beforeEach(() => {
  shown.online = true;
});

describe("AddRecipeScreen", () => {
  it("names the Favorite Site it was opened from and leaves the address empty", () => {
    const html = render({ fromSite: "Synthetic Kitchen" });
    expect(html).toContain(
      "Adding a recipe from Synthetic Kitchen. Find one at that site, then paste its address here.",
    );
    expect(html).toMatch(/<input[^>]*id="recipe-url"[^>]*value=""/);
  });

  it("shows no hint otherwise", () => {
    expect(render()).not.toContain("Adding a recipe from");
  });
});

describe("QueuedItem", () => {
  const item = (
    queued: QueuedIngest,
    blocked: "offline" | "paused" | null = null,
    discarding = false,
  ) =>
    renderToStaticMarkup(
      <QueuedItem
        item={queued}
        blocked={blocked}
        discarding={discarding}
        onPaste={() => {}}
        onDiscard={() => {}}
      />,
    );
  const waiting: QueuedIngest = { ...needsPage, state: "waiting" };

  it.each([
    ["needing its page", needsPage],
    ["waiting", waiting],
  ])("offers paste and discard on one %s, naming which", (_state, queued) => {
    const html = item(queued);
    expect(html).toContain("Paste its page");
    expect(html).toContain("Discard");
    expect(html.match(/> for https:\/\/kitchen\.example\.com\/stew</g)).toHaveLength(2);
  });

  it("turns both offers off while offline or paused", () => {
    expect(item(needsPage)).not.toMatch(/<button[^>]*disabled=""/);
    for (const blocked of ["offline", "paused"] as const) {
      expect(item(waiting, blocked).match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    }
  });

  it("marks the discard as busy while it's on its way", () => {
    expect(item(needsPage)).toMatch(/<button[^>]*aria-disabled="false"/);
    expect(item(needsPage, null, true)).toMatch(/<button[^>]*aria-disabled="true"/);
  });
});

describe("PastePage", () => {
  const paste = () =>
    renderToStaticMarkup(<PastePage item={needsPage} onIngested={() => {}} onBack={() => {}} />);

  it("asks for the page's source and links to the page", () => {
    const html = paste();
    expect(html).toContain("source (HTML)");
    expect(html).toContain('href="https://kitchen.example.com/stew"');
    expect(html).toContain("Synthetic Kitchen");
  });

  it("leaves a huge paste unwrapped, unchecked and out of autofill", () => {
    const html = paste();
    expect(html).toMatch(/<textarea[^>]*wrap="off"/);
    expect(html).toMatch(/<textarea[^>]*spellCheck="false"/);
    expect(html).toMatch(/<textarea[^>]*autoComplete="off"/);
  });

  it("is off while offline, and says why", () => {
    shown.online = false;
    const html = paste();
    expect(html).toMatch(/<fieldset disabled/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
    expect(html).toContain("You’re offline. Paste the page once you’re back online.");
  });
});
