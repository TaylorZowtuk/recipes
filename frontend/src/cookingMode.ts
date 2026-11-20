// Whether cooking mode is open. While it is, the sync engine holds off installing a new build, so
// the page can't reload under the cook; the next poll after it closes installs it.
let opened = 0;

export const isCookingModeOpen = () => opened > 0;

/** Marks cooking mode open until the returned release is called; a second call does nothing. */
export function openCookingMode(): () => void {
  opened += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    opened -= 1;
  };
}
