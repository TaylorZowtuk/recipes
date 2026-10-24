import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** Whether the device has a network, for the edits that are off while offline. */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine);
