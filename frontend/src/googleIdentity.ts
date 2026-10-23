// The part of Google Identity Services (https://developers.google.com/identity/gsi/web) the sign-in
// screen uses: the Sign in with Google button, in popup mode only. Popup mode keeps an installed
// iOS app's sign-in inside the app (docs/adr/2026-09-29-editor-sign-in.md).

export type GoogleIdentity = {
  initialize(config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    ux_mode: "popup";
    auto_select?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "large" | "medium" | "small";
      text?: "signin_with" | "signin" | "continue_with";
      shape?: "rectangular" | "pill" | "circle" | "square";
      width?: number;
    },
  ): void;
  disableAutoSelect(): void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

const SCRIPT = "https://accounts.google.com/gsi/client";
let loading: Promise<GoogleIdentity> | undefined;

/** Loads Google's script the first time sign-in needs it. A failed load is forgotten, to retry. */
export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      const id = window.google?.accounts?.id;
      if (id) resolve(id);
      else reject(new Error("Google Identity Services didn't load"));
    };
    script.onerror = () => reject(new Error("Couldn't load Google Identity Services"));
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = undefined;
    for (const script of document.querySelectorAll(`script[src="${SCRIPT}"]`)) script.remove();
    throw error;
  });
  return loading;
}

/** After signing out, so Google doesn't sign this device straight back in. */
export function forgetGoogleSignIn() {
  window.google?.accounts?.id?.disableAutoSelect();
}
