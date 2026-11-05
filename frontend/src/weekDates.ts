// Calendar arithmetic for the Week Plan, on local "YYYY-MM-DD" days. The device's calendar decides
// what today is, so a Date goes through its local fields only: never toISOString, which is UTC.
// Days step by calendar field, not by 24 hours, so a clock change can't skip or repeat one.

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function parse(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(day: string, days: number): string {
  const date = parse(day);
  return isoDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

export function mondayOf(day: string): string {
  return addDays(day, -((parse(day).getDay() + 6) % 7));
}

// ISO days sort as strings. Today isn't past.
export const isPast = (day: string, today: string) => day < today;

// A day of the week starting at `monday`, 0 for Monday, as "Mon 2".
export function dayLabel(monday: string, day: number): string {
  return `${DAY_NAMES[day]} ${parse(addDays(monday, day)).getDate()}`;
}

export function weekRange(monday: string): string {
  return `${monthDay.format(parse(monday))} – ${monthDay.format(parse(addDays(monday, 6)))}`;
}

function weekName(monday: string, today: string): string | undefined {
  const thisWeek = mondayOf(today);
  if (monday === thisWeek) return "This week";
  return monday === addDays(thisWeek, 7) ? "Next week" : undefined;
}

export const weekLabel = (monday: string, today: string) =>
  weekName(monday, today) ?? weekRange(monday);

// The date range under a week's label, unless the label is already the range.
export const weekSubtitle = (monday: string, today: string) =>
  weekName(monday, today) && weekRange(monday);
