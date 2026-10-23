import { describe, expect, it } from "vitest";
import { createApi } from "./api/client";
import { createSessionStore, type RoleStorage } from "./session";

type Reply = { status: number; body?: unknown } | "offline";
type Call = { method: string; path: string; body: string };

// A fake API: each request takes the next reply queued for its method, and is recorded.
function fakeApi(replies: Partial<Record<string, Reply[]>>) {
  const calls: Call[] = [];
  const fetch = async (input: Request) => {
    calls.push({
      method: input.method,
      path: new URL(input.url).pathname,
      body: await input.text(),
    });
    const reply = replies[input.method]?.shift();
    if (!reply) throw new Error(`No reply queued for ${input.method}`);
    if (reply === "offline") throw new TypeError("Failed to fetch");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { api: createApi({ baseUrl: "https://plateful.test", fetch }), calls };
}

function memoryStorage(
  initial: Record<string, string> = {},
): RoleStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const blockedStorage: RoleStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const visitor = { editor: false, email: null, google_client_id: "client-123" };
const editor = { editor: true, email: "editor@example.com", google_client_id: "client-123" };
const rememberedEditor = () =>
  memoryStorage({ "plateful.role": JSON.stringify({ editor: true, email: "editor@example.com" }) });

describe("the session store", () => {
  it("starts as a visitor and loads the session", async () => {
    const { api, calls } = fakeApi({ GET: [{ status: 200, body: visitor }] });
    const store = createSessionStore({ api, storage: memoryStorage() });
    expect(store.getSnapshot()).toMatchObject({ isEditor: false, status: "loading" });

    await store.load();

    expect(calls).toEqual([{ method: "GET", path: "/api/session", body: "" }]);
    expect(store.getSnapshot()).toEqual({
      isEditor: false,
      email: null,
      googleClientId: "client-123",
      status: "loaded",
    });
  });

  it("loads an editor's session and remembers the role", async () => {
    const { api } = fakeApi({ GET: [{ status: 200, body: editor }] });
    const storage = memoryStorage();
    const store = createSessionStore({ api, storage });

    await store.load();

    expect(store.getSnapshot()).toMatchObject({ isEditor: true, email: "editor@example.com" });
    expect(JSON.parse(storage.items.get("plateful.role") ?? "null")).toEqual({
      editor: true,
      email: "editor@example.com",
    });
  });

  it("shows the remembered editor at once, before the session loads", () => {
    const { api } = fakeApi({});
    const store = createSessionStore({ api, storage: rememberedEditor() });
    expect(store.getSnapshot()).toMatchObject({
      isEditor: true,
      email: "editor@example.com",
      status: "loading",
    });
  });

  it("keeps the remembered editor when the session can't be loaded", async () => {
    const { api } = fakeApi({ GET: ["offline"] });
    const store = createSessionStore({ api, storage: rememberedEditor() });

    await store.load();

    expect(store.getSnapshot()).toMatchObject({
      isEditor: true,
      email: "editor@example.com",
      googleClientId: null,
      status: "failed",
    });
  });

  it("keeps the remembered editor when the API is throttled", async () => {
    const { api } = fakeApi({ GET: [{ status: 503, body: { detail: "Throttled" } }] });
    const store = createSessionStore({ api, storage: rememberedEditor() });

    await store.load();

    expect(store.getSnapshot()).toMatchObject({ isEditor: true, status: "failed" });
  });

  it("forgets the remembered editor when the session has ended", async () => {
    const { api } = fakeApi({ GET: [{ status: 200, body: visitor }] });
    const storage = rememberedEditor();
    const store = createSessionStore({ api, storage });

    await store.load();

    expect(store.getSnapshot()).toMatchObject({ isEditor: false, email: null });
    expect(storage.items.has("plateful.role")).toBe(false);
  });

  it("ignores a remembered role it can't read", () => {
    const { api } = fakeApi({});
    const store = createSessionStore({ api, storage: memoryStorage({ "plateful.role": "{oops" }) });
    expect(store.getSnapshot().isEditor).toBe(false);
  });

  it("works without storage", async () => {
    const { api } = fakeApi({ GET: [{ status: 200, body: editor }], DELETE: [{ status: 204 }] });
    const store = createSessionStore({ api, storage: blockedStorage });
    expect(store.getSnapshot().isEditor).toBe(false);

    await store.load();
    expect(store.getSnapshot().isEditor).toBe(true);
    expect(await store.signOut()).toBe(true);
    expect(store.getSnapshot().isEditor).toBe(false);
  });

  it("tells subscribers when the session changes", async () => {
    const { api } = fakeApi({ GET: [{ status: 200, body: editor }] });
    const store = createSessionStore({ api, storage: memoryStorage() });
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().isEditor));

    await store.load();
    unsubscribe();

    expect(seen).toEqual([true]);
  });
});

describe("signing in", () => {
  it("posts the Google credential and becomes an editor", async () => {
    const { api, calls } = fakeApi({
      GET: [{ status: 200, body: visitor }],
      POST: [{ status: 200, body: editor }],
    });
    const storage = memoryStorage();
    const store = createSessionStore({ api, storage });
    await store.load();

    expect(await store.signIn("google-id-token")).toEqual({ ok: true });

    expect(calls[1]).toEqual({
      method: "POST",
      path: "/api/session",
      body: JSON.stringify({ credential: "google-id-token" }),
    });
    expect(store.getSnapshot()).toMatchObject({ isEditor: true, email: "editor@example.com" });
    expect(storage.items.has("plateful.role")).toBe(true);
  });

  it.each([
    [403, "not-an-editor"],
    [401, "invalid"],
    [503, "unavailable"],
    [500, "unavailable"],
  ] as const)("reports a %i as %s and stays a visitor", async (status, reason) => {
    const { api } = fakeApi({ POST: [{ status, body: { detail: "No" } }] });
    const storage = memoryStorage();
    const store = createSessionStore({ api, storage });

    expect(await store.signIn("google-id-token")).toEqual({ ok: false, reason });

    expect(store.getSnapshot().isEditor).toBe(false);
    expect(storage.items.has("plateful.role")).toBe(false);
  });

  it("reports being offline", async () => {
    const { api } = fakeApi({ POST: ["offline"] });
    const store = createSessionStore({ api, storage: memoryStorage() });
    expect(await store.signIn("google-id-token")).toEqual({ ok: false, reason: "offline" });
  });
});

describe("signing out", () => {
  it("ends the session, forgets the role and shows a visitor", async () => {
    const { api, calls } = fakeApi({
      GET: [{ status: 200, body: editor }],
      DELETE: [{ status: 204 }],
    });
    const storage = memoryStorage();
    const store = createSessionStore({ api, storage });
    await store.load();

    expect(await store.signOut()).toBe(true);

    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/session" });
    expect(store.getSnapshot()).toMatchObject({ isEditor: false, email: null });
    expect(storage.items.has("plateful.role")).toBe(false);
  });

  it("stays signed in when the session can't be ended", async () => {
    // The cookie is HttpOnly, so only the API can clear it.
    const { api } = fakeApi({ GET: [{ status: 200, body: editor }], DELETE: ["offline"] });
    const storage = memoryStorage();
    const store = createSessionStore({ api, storage });
    await store.load();

    expect(await store.signOut()).toBe(false);

    expect(store.getSnapshot().isEditor).toBe(true);
    expect(storage.items.has("plateful.role")).toBe(true);
  });
});
