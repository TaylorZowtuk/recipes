import { useEffect, useRef, useState } from "react";

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
  why?: string;
  onUndo?: (batch: string) => void;
  onDone: () => void;
}) {
  // The timer waits while the toast has focus or the pointer, so Undo can't vanish mid-reach,
  // and starts afresh after.
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const held = focused || hovered;
  const shown = useRef<HTMLDivElement>(null);
  // A control removed with focus or the pointer on it fires no blur or leave, so each new toast
  // asks afresh.
  useEffect(() => {
    setFocused(!!toast && !!shown.current?.contains(document.activeElement));
    if (!toast) setHovered(false);
  }, [toast]);
  useEffect(() => {
    if (!toast || held) return;
    const timer = setTimeout(onDone, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast, held, onDone]);

  return (
    <div role="status" className="toast-region">
      {toast && (
        // biome-ignore lint/a11y/noStaticElementInteractions: it only notices focus and the mouse.
        <div
          ref={shown}
          className="toast"
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
          // Only a mouse hovers: a tap leaves a touch pointer "over" the toast until the next one.
          onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <span>
            {toast.text}
            {toast.undo && why && <span className="toast-why"> {why}</span>}
          </span>
          {toast.undo && (
            <button
              type="button"
              className="text-button toast-undo"
              disabled={disabled}
              onClick={() => toast.undo && onUndo?.(toast.undo)}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
