// A Stated Time in seconds, compactly: "45 min", "1 hr 15 min" or "3 hr", to the nearest minute.
// Null when the source gave no time.
export function formatStatedTime(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

// Whole days, hours, minutes and seconds, the grammar ingest stores seconds for, so humanized text
// always matches the time a card shows. Months, years, fractions and lower case stay as written.
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const UNIT_SECONDS = [86400, 3600, 60, 1];

// A Stated Time's text for display: an ISO 8601 duration ("PT1H15M") humanized ("1 hr 15 min"),
// and any other text exactly as the Source wrote it.
export function statedTimeText(text: string): string {
  const match = ISO_DURATION.exec(text.trim());
  const parts = match?.slice(1) ?? [];
  if (!parts.some(Boolean)) return text;
  const seconds = parts.reduce(
    (sum, part, i) => sum + Number(part ?? 0) * (UNIT_SECONDS[i] ?? 0),
    0,
  );
  return (Number.isFinite(seconds) && formatStatedTime(seconds)) || text;
}
