// Where Back goes: one step back through history, or Recipes when this screen is the app's first
// history entry (a shared link or a reload), so Back never leaves the app. `historyIndex` is the
// position React Router keeps in `window.history.state.idx`, counted from where the app was opened.
export function backTarget(historyIndex: number | undefined): -1 | "/recipes" {
  return historyIndex !== undefined && historyIndex > 0 ? -1 : "/recipes";
}
