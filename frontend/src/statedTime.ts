// A Stated Time in seconds, compactly: "45 min", "1 h 15 min" or "3 h", to the nearest minute.
// Null when the source gave no time.
export function formatStatedTime(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
