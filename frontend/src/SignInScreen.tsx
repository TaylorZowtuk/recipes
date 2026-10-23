import { type ReactNode, useEffect, useRef, useState } from "react";
import { loadGoogleIdentity } from "./googleIdentity";
import { Screen, useBack } from "./Screen";
import { type SignInResult, useSession } from "./session";

type Problem = Exclude<SignInResult, { ok: true }>["reason"] | "google-unreachable";

const messages: Record<Problem, string> = {
  "not-an-editor": "This Google account isn’t one of this kitchen’s editors.",
  invalid: "Google sign-in didn’t go through. Try again.",
  unavailable: "Sign-in isn’t available right now. Try again later.",
  offline: "You’re offline. Sign in once you’re back online.",
  "google-unreachable": "Couldn’t reach Google. Check your connection and try again.",
};

// Sign in with Google, in a popup, then back to where sign-in was opened from as an editor.
export function SignInScreen() {
  const { isEditor, email, googleClientId, status, signIn, load, retryIfFailed } = useSession();
  const back = useBack();
  const button = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<Problem>();
  const [signingIn, setSigningIn] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Google keeps the callback it was first given, even after this screen has gone: the popup can
  // finish once the person has moved on, and then they're signed in where they are.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onCredential = useRef<(credential: string) => void>(() => {});
  onCredential.current = async (credential) => {
    setProblem(undefined);
    setSigningIn(true);
    const result = await signIn(credential);
    if (!mounted.current) return;
    setSigningIn(false);
    if (result.ok) back();
    else setProblem(result.reason);
  };

  // A session that couldn't be loaded (offline, or the API was down) is tried again here.
  useEffect(() => {
    void retryIfFailed();
  }, [retryIfFailed]);

  const ready = !isEditor && status === "loaded" && googleClientId !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs it on Try again.
  useEffect(() => {
    if (!ready || googleClientId === null) return;
    let current = true;
    loadGoogleIdentity().then(
      (google) => {
        if (!current || !button.current) return;
        google.initialize({
          client_id: googleClientId,
          callback: ({ credential }) => onCredential.current(credential),
          ux_mode: "popup",
          auto_select: false,
        });
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        google.renderButton(button.current, {
          type: "standard",
          theme: dark ? "filled_black" : "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
        });
      },
      () => current && setProblem("google-unreachable"),
    );
    return () => {
      current = false;
    };
  }, [ready, googleClientId, attempt]);

  const retry = () => {
    setProblem(undefined);
    setAttempt((n) => n + 1);
  };

  let body: ReactNode;
  if (isEditor) {
    body = (
      <p>
        You’re signed in as <strong>{email}</strong>.
      </p>
    );
  } else if (status === "loading") {
    body = <p className="screen-note">Checking…</p>;
  } else if (status === "failed" || googleClientId === null) {
    body = (
      <div className="sign-in-problem-row">
        <p role="alert" className="sign-in-problem">
          {status === "failed" && !navigator.onLine ? messages.offline : messages.unavailable}
        </p>
        <button type="button" className="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <p>
          Sign in with the Google account on this kitchen’s list of editors to add and change
          recipes. Anyone can browse without signing in.
        </p>
        {/* Google's button covers the note (or replaces it) once its script has loaded. */}
        <div ref={button} className="google-button">
          {problem !== "google-unreachable" && (
            <p className="screen-note">Loading Google sign-in…</p>
          )}
        </div>
        <p role="status" className="screen-note">
          {signingIn ? "Signing in…" : ""}
        </p>
        {problem && (
          <div className="sign-in-problem-row">
            <p role="alert" className="sign-in-problem">
              {messages[problem]}
            </p>
            {problem === "google-unreachable" && (
              <button type="button" className="button" onClick={retry}>
                Try again
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <Screen title="Editor sign-in" pushed>
      <div className="sign-in">{body}</div>
    </Screen>
  );
}
