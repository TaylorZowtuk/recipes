import { describe, expect, it, vi } from "vitest";
import { createApi } from "./api/client";
import { createSessionStore, type RoleStorage } from "./session";

type Reply = { status: number; body?: unknown } | "offline";
type Queued = Reply | Promise<Reply>;
type Call = { method: string; path: string; body: string };

// A fake API: each request takes the next reply queued for its method, and is recorded.
function fakeApi(replies: Partial<Record<string, Queued[]>>) {
  const calls: Call[] = [];
  const fetch = async (input: Request) => {
    calls.push({
      method: input.method,
      path: new URL(input.url).pathname,
      body: await input.text(),
    });
    const reply = await replies[input.method]?.shift();
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

// A reply that arrives only when the test says so.
function deferred() {
  let resolve: (reply: Reply) => void = () => {};
  const promise = new Promise<Reply>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  it("tries again when the device comes back online after a failed load", async () => {
    const { api, calls } = fakeApi({ GET: ["offline", { status: 200, body: editor }] });
    const connectivity = new EventTarget();
    const store = createSessionStore({ api, storage: memoryStorage(), connectivity });
    await store.load();
    expect(store.getSnapshot().status).toBe("failed");

    connectivity.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("loaded"));

    expect(calls).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({ isEditor: true, email: "editor@example.com" });
  });

  it("doesn't reload on coming back online once the session has loaded", async () => {
    const { api, calls } = fakeApi({ GET: [{ status: 200, body: visitor }] });
    const connectivity = new EventTarget();
    const store = createSessionStore({ api, storage: memoryStorage(), connectivity });
    await store.load();

    connectivity.dispatchEvent(new Event("online"));
    await store.retryIfFailed();

    expect(calls).toHaveLength(1);
  });

  it("retries a failed load when asked, showing it's checking again", async () => {
    const reply = deferred();
    const { api } = fakeApi({ GET: ["offline", reply.promise] });
    const store = createSessionStore({ api, storage: memoryStorage() });
    await store.load();

    const retried = store.retryIfFailed();
    expect(store.getSnapshot().status).toBe("loading");
    reply.resolve({ status: 200, body: visitor });
    await retried;

    expect(store.getSnapshot()).toMatchObject({ status: "loaded", googleClientId: "client-123" });
  });

  it("doesn't let a load that was in flight undo a sign-out", async () => {
    const reply = deferred();
    const { api } = fakeApi({ GET: [reply.promise], DELETE: [{ status: 204 }] });
    const storage = rememberedEditor();
    const store = createSessionStore({ api, storage });

    const loading = store.load();
    const signingOut = store.signOut();
    // The GET was answered while the cookie was still valid.
    reply.resolve({ status: 200, body: editor });
    expect(await signingOut).toBe(true);
    await loading;

    expect(store.getSnapshot()).toMatchObject({ isEditor: false, email: null });
    expect(storage.items.has("plateful.role")).toBe(false);
  });

  it("waits for a load in flight before ending the session", async () => {
    // The GET can re-issue the cookie, so a DELETE answered before it would be undone on the API.
    const reply = deferred();
    const { api, calls } = fakeApi({ GET: [reply.promise], DELETE: [{ status: 204 }] });
    const store = createSessionStore({ api, storage: rememberedEditor() });

    const loading = store.load();
    const signingOut = store.signOut();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.map((call) => call.method)).toEqual(["GET"]);

    reply.resolve({ status: 200, body: editor });
    expect(await signingOut).toBe(true);
    await loading;

    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(store.getSnapshot()).toMatchObject({ isEditor: false, email: null });
  });

  it("ends the session after 30 s even when the load in flight never settles", async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi({ GET: [deferred().promise], DELETE: [{ status: 204 }] });
      const store = createSessionStore({ api, storage: rememberedEditor() });

      void store.load();
      const signingOut = store.signOut();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(calls.map((call) => call.method)).toEqual(["GET"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(await signingOut).toBe(true);
      expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
      expect(store.getSnapshot()).toMatchObject({ isEditor: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't let a load that was in flight undo a sign-in", async () => {
    const reply = deferred();
    const { api } = fakeApi({ GET: [reply.promise], POST: [{ status: 200, body: editor }] });
    const store = createSessionStore({ api, storage: memoryStorage() });

    const loading = store.load();
    expect(await store.signIn("google-id-token")).toEqual({ ok: true });
    reply.resolve({ status: 200, body: visitor });
    await loading;

    expect(store.getSnapshot()).toMatchObject({ isEditor: true, status: "loaded" });
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

  it.each([
    ["offline", "offline"],
    ["throttled", { status: 503, body: { detail: "Throttled" } }],
    ["forbidden", { status: 403, body: { detail: "Forbidden" } }],
  ] as const)("stays signed in when the session can't be ended (%s)", async (_, reply) => {
    // The cookie is HttpOnly, so only the API can clear it.
    const { api } = fakeApi({ GET: [{ status: 200, body: editor }], DELETE: [reply] });
    const storage = memoryStorage();
    const store = createSessionStore({ api, storage });
    await store.load();

    expect(await store.signOut()).toBe(false);

    expect(store.getSnapshot().isEditor).toBe(true);
    expect(storage.items.has("plateful.role")).toBe(true);
  });
});
