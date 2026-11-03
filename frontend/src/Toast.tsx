import { useEffect } from "react";

const SHOWN_MS = 10_000;

// What a toast says, and the Confirm Batch its Undo reverses, if any.
export type ToastMessage = { text: string; undo?: string };

// A short message at the foot of the screen, with Undo when there's a Confirm Batch to reverse.
// The status region stays mounted so screen readers announce each new message; it goes after a
// while, or as soon as another replaces it.
export function Toast({
  toast,
  disabled = false,
  why,
  onUndo,
  onDone,
}: {
  toast: ToastMessage | null;
  disabled?: boolean;
  // Why Undo is off, when it's off for a reason beyond a write in flight.
  why?: string | false;
  onUndo: (batch: string) => void;
  onDone: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDone, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast, onDone]);

  return (
    <div role="status" className="toast-region">
      {toast && (
        <div className="toast">
          <span>
            {toast.text}
            {toast.undo && why && <span className="toast-why"> {why}</span>}
          </span>
          {toast.undo && (
            <button
              type="button"
              className="text-button toast-undo"
              disabled={disabled}
              onClick={() => toast.undo && onUndo(toast.undo)}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
