// Whether cooking mode is open. While it is, the sync engine holds off installing a new build, so
// the page can't reload under the cook; the next poll after it closes installs it.
let open = false;
const listeners = new Set<() => void>();

export const isCookingModeOpen = () => open;

export function setCookingModeOpen(next: boolean) {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

export function subscribeCookingMode(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
