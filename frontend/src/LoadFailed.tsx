import type { RefObject } from "react";

// What couldn't be loaded, or that it isn't available offline, announced as an alert, and a button
// to try again. The button goes away once the retry starts, so it first moves focus to the
// screen's status note.
export function LoadFailed({
  what,
  offline = false,
  retry,
  status,
}: {
  what: string;
  offline?: boolean;
  retry: () => void;
  status: RefObject<HTMLElement | null>;
}) {
  const tryAgain = () => {
    status.current?.focus();
    retry();
  };
  return (
    <div className="screen-note">
      <p role="alert">{offline ? "Not available offline." : `${what} couldn’t be loaded.`}</p>
      <button type="button" className="button" onClick={tryAgain}>
        Try again
      </button>
    </div>
  );
}
