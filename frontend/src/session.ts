import { type ReactNode, useSyncExternalStore } from "react";
import { type createApi, api as defaultApi } from "./api/client";
import type { components } from "./api/schema";

// Whether this device is signed in as an editor. Components ask only "is this an editor"
// (useIsEditor, EditorOnly); how someone signed in stays here and in the API.

export type SessionSnapshot = {
  isEditor: boolean;
  email: string | null;
  /** The Google client ID to sign in with, once loaded; null when sign-in isn't configured. */
  googleClientId: string | null;
  /** "failed": the session couldn't be loaded, so the role shown is the remembered one. */
  status: "loading" | "loaded" | "failed";
};

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: "not-an-editor" | "invalid" | "unavailable" | "offline" };

export type RoleStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Api = ReturnType<typeof createApi>;
type Session = components["schemas"]["Session"];

// The last known role, so an editor's UI survives offline or a failed load until it's revalidated.
const ROLE_KEY = "plateful.role";

function readRole(storage: RoleStorage | undefined): { editor: boolean; email: string | null } {
  try {
    const value: unknown = JSON.parse(storage?.getItem(ROLE_KEY) ?? "null");
    if (value && typeof value === "object" && "editor" in value && value.editor === true) {
      const email = "email" in value && typeof value.email === "string" ? value.email : null;
      return { editor: true, email };
    }
  } catch {
    // Unreadable or blocked storage: no remembered role.
  }
  return { editor: false, email: null };
}

function writeRole(storage: RoleStorage | undefined, editor: boolean, email: string | null) {
  try {
    if (!editor) storage?.removeItem(ROLE_KEY);
    else storage?.setItem(ROLE_KEY, JSON.stringify({ editor: true, email }));
  } catch {
    // Storage is a convenience: without it the role is known once the session loads.
  }
}

export function createSessionStore({
  api,
  storage,
  connectivity,
}: {
  api: Api;
  storage?: RoleStorage;
  /** Fires "online" when the device reconnects (the window), to retry a failed load. */
  connectivity?: Pick<EventTarget, "addEventListener">;
}) {
  const remembered = readRole(storage);
  let snapshot: SessionSnapshot = {
    isEditor: remembered.editor,
    email: remembered.email,
    googleClientId: null,
    status: "loading",
  };
  const listeners = new Set<() => void>();
  // Bumped when a sign-in or sign-out changes the role, so a load that was already in flight (on a
  // slow network) can't undo it: that load's answer predates the new cookie.
  let roleChanges = 0;

  const update = (changes: Partial<SessionSnapshot>) => {
    snapshot = { ...snapshot, ...changes };
    if ("isEditor" in changes) writeRole(storage, snapshot.isEditor, snapshot.email);
    for (const listener of listeners) listener();
  };

  const fromSession = (session: Session): Partial<SessionSnapshot> => ({
    isEditor: session.editor,
    email: session.editor ? session.email : null,
    googleClientId: session.google_client_id,
  });

  async function load() {
    const before = roleChanges;
    if (snapshot.status !== "loading") update({ status: "loading" });
    let data: Session | undefined;
    try {
      ({ data } = await api.GET("/api/session"));
    } catch {
      // Offline: fall through and keep the remembered role.
    }
    if (!data) return update({ status: "failed" });
    const { isEditor, email, ...rest } = fromSession(data);
    const role = before === roleChanges ? { isEditor, email } : {};
    update({ ...role, ...rest, status: "loaded" });
  }

  /** Loads the session again only if the last load failed. */
  const retryIfFailed = () => (snapshot.status === "failed" ? load() : Promise.resolve());

  connectivity?.addEventListener("online", () => void retryIfFailed());

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    load,
    retryIfFailed,

    async signIn(credential: string): Promise<SignInResult> {
      try {
        const { data, response } = await api.POST("/api/session", { body: { credential } });
        if (data) {
          roleChanges++;
          update({ ...fromSession(data), status: "loaded" });
          return { ok: true };
        }
        if (response.status === 403) return { ok: false, reason: "not-an-editor" };
        if (response.status === 401) return { ok: false, reason: "invalid" };
        return { ok: false, reason: "unavailable" };
      } catch {
        return { ok: false, reason: "offline" };
      }
    },

    /** False when the API couldn't be reached: its cookie is HttpOnly, so this stays signed in. */
    async signOut(): Promise<boolean> {
      try {
        const { response } = await api.DELETE("/api/session");
        if (!response.ok) return false;
      } catch {
        return false;
      }
      roleChanges++;
      update({ isEditor: false, email: null });
      return true;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

function browserStorage(): RoleStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// The app's one session, loaded once per page load.
// A failed load is retried when the device comes back online, and when sign-in opens.
export const session = createSessionStore({
  api: defaultApi,
  storage: browserStorage(),
  connectivity: typeof window !== "undefined" ? window : undefined,
});
if (typeof window !== "undefined") void session.load();

export function useSession(): SessionSnapshot &
  Pick<SessionStore, "signIn" | "signOut" | "load" | "retryIfFailed"> {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { signIn, signOut, load, retryIfFailed } = session;
  return { ...snapshot, signIn, signOut, load, retryIfFailed };
}

/** Whether this device's person may edit. The gate for editing controls and review marks. */
export const useIsEditor = () =>
  useSyncExternalStore(session.subscribe, () => session.getSnapshot().isEditor);

/** Shows its children only to an editor, and `fallback` (nothing by default) to a visitor. */
export function EditorOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useIsEditor() ? children : fallback;
}
