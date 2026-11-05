import { afterEach, describe, expect, it } from "vitest";
import {
  addDays,
  dayLabel,
  isoDate,
  isPast,
  mondayOf,
  weekLabel,
  weekRange,
  weekSubtitle,
} from "./weekDates";

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("isoDate", () => {
  it("names the device's local day, even when UTC has moved on to the next one", () => {
    process.env.TZ = "America/Edmonton";
    expect(isoDate(new Date(2026, 10, 1, 23, 30))).toBe("2026-11-01");
  });

  it("names the device's local day, even when UTC is still on the day before", () => {
    process.env.TZ = "Pacific/Auckland";
    expect(isoDate(new Date(2026, 10, 2, 0, 30))).toBe("2026-11-02");
  });
});

describe("mondayOf", () => {
  it("is the day itself on a Monday", () => {
    expect(mondayOf("2026-11-02")).toBe("2026-11-02");
  });

  it("goes back to the Monday from any other day, Sunday last", () => {
    expect(mondayOf("2026-11-04")).toBe("2026-11-02");
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
  });

  it.each([
    ["America/Edmonton", "2026-03-08", "2026-03-02"], // clocks go forward that Sunday
    ["America/Edmonton", "2026-11-01", "2026-10-26"], // clocks go back that Sunday
    ["Pacific/Auckland", "2026-04-05", "2026-03-30"],
    ["America/Havana", "2026-03-08", "2026-03-02"], // midnight itself doesn't exist that day
  ])("keeps to the calendar across a clock change in %s", (tz, day, monday) => {
    process.env.TZ = tz;
    expect(mondayOf(day)).toBe(monday);
  });

  it("crosses a year's end", () => {
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
    expect(mondayOf("2026-01-01")).toBe("2025-12-29");
  });
});

describe("addDays", () => {
  it("steps a whole week across a clock change", () => {
    process.env.TZ = "America/Edmonton";
    expect(addDays("2026-10-26", 7)).toBe("2026-11-02");
    expect(addDays("2026-11-02", -7)).toBe("2026-10-26");
    expect(addDays("2026-03-02", 7)).toBe("2026-03-09");
  });

  it("crosses a month's and a year's end", () => {
    expect(addDays("2026-12-28", 6)).toBe("2027-01-03");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("isPast", () => {
  it("is true of the days before today only: today isn't past", () => {
    expect(isPast("2026-11-02", "2026-11-03")).toBe(true);
    expect(isPast("2026-11-03", "2026-11-03")).toBe(false);
    expect(isPast("2026-11-04", "2026-11-03")).toBe(false);
  });

  it("compares across a year's end", () => {
    expect(isPast("2026-12-31", "2027-01-01")).toBe(true);
    expect(isPast("2027-01-01", "2026-12-31")).toBe(false);
  });
});

describe("dayLabel", () => {
  it("names each day of a week from Monday, with its date", () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((day) => dayLabel("2026-12-28", day));
    expect(days).toEqual(["Mon 28", "Tue 29", "Wed 30", "Thu 31", "Fri 1", "Sat 2", "Sun 3"]);
  });
});

describe("week labels", () => {
  const today = "2026-11-04";

  it("names this week and next", () => {
    expect(weekLabel("2026-11-02", today)).toBe("This week");
    expect(weekLabel("2026-11-09", today)).toBe("Next week");
  });

  it("gives any other week as its date range", () => {
    expect(weekLabel("2026-10-26", today)).toBe("Oct 26 – Nov 1");
    expect(weekLabel("2026-11-16", today)).toBe("Nov 16 – Nov 22");
  });

  it("counts Sunday as part of the week that began the Monday before", () => {
    expect(weekLabel("2026-11-02", "2026-11-08")).toBe("This week");
  });

  it("writes a range across a year's end", () => {
    expect(weekRange("2026-12-28")).toBe("Dec 28 – Jan 3");
  });

  it("adds the date range under a named week only", () => {
    expect(weekSubtitle("2026-11-02", today)).toBe("Nov 2 – Nov 8");
    expect(weekSubtitle("2026-11-09", today)).toBe("Nov 9 – Nov 15");
    expect(weekSubtitle("2026-10-26", today)).toBeUndefined();
  });
});
