// Where Back goes: one step back through history, or Recipes when this screen was the first one
// opened (a shared link or a reload), so Back never leaves the app.
export function backTarget(locationKey: string): -1 | "/recipes" {
  return locationKey === "default" ? "/recipes" : -1;
}
