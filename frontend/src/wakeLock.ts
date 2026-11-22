import { useEffect, useState } from "react";

export type ScreenStatus = "asking" | "on" | "off";

type Sentinel = Pick<EventTarget, "addEventListener"> & { release: () => Promise<void> };
export type WakeLockNavigator = {
  wakeLock?: { request: (type: "screen") => Promise<Sentinel> };
};
type Visibility = Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
  visibilityState: DocumentVisibilityState;
};

// Keeps the screen on with the Screen Wake Lock until stopped, saying how that's going. The browser
// lets the lock go when the page is hidden, so it asks again whenever the page is shown without one,
// quietly: past the first ask it says only whether the screen stays on.
export function keepScreenOn(
  nav: WakeLockNavigator,
  doc: Visibility,
  onStatus: (status: ScreenStatus) => void,
): () => void {
  const wakeLock = nav.wakeLock;
  if (!wakeLock) {
    onStatus("off");
    return () => {};
  }
  let stopped = false;
  let held: Sentinel | undefined;
  let asking = false;

  const ask = () => {
    asking = true;
    wakeLock.request("screen").then(
      (sentinel) => {
        asking = false;
        if (stopped) {
          void sentinel.release();
          return;
        }
        held = sentinel;
        sentinel.addEventListener("release", () => {
          if (held !== sentinel) return;
          held = undefined;
          if (!stopped) onStatus("off");
        });
        onStatus("on");
      },
      () => {
        asking = false;
        if (!stopped) onStatus("off");
      },
    );
  };
  const shown = () => {
    if (doc.visibilityState === "visible" && !held && !asking) ask();
  };

  doc.addEventListener("visibilitychange", shown);
  onStatus("asking");
  ask();
  return () => {
    stopped = true;
    doc.removeEventListener("visibilitychange", shown);
    const sentinel = held;
    held = undefined;
    void sentinel?.release();
  };
}

/** Keeps the screen on while mounted; what the browser has said about it. */
export function useWakeLock(
  nav: WakeLockNavigator = navigator as WakeLockNavigator,
  doc: Visibility = document,
): ScreenStatus {
  const [status, setStatus] = useState<ScreenStatus>(nav.wakeLock ? "asking" : "off");
  useEffect(() => keepScreenOn(nav, doc, setStatus), [nav, doc]);
  return status;
}
