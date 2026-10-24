import { describe, expect, it } from "vitest";
import { formatStatedTime, statedTimeText } from "./statedTime";

describe("formatStatedTime", () => {
  it("shows minutes under an hour", () => {
    expect(formatStatedTime(45 * 60)).toBe("45 min");
  });

  it("shows hours and minutes", () => {
    expect(formatStatedTime(75 * 60)).toBe("1 hr 15 min");
  });

  it("leaves out the minutes on the hour", () => {
    expect(formatStatedTime(3 * 3600)).toBe("3 hr");
  });

  it("rounds to the nearest minute, and never down to nothing", () => {
    expect(formatStatedTime(89)).toBe("1 min");
    expect(formatStatedTime(20)).toBe("1 min");
    expect(formatStatedTime(3599)).toBe("1 hr");
  });

  it("is nothing when the source gave no time", () => {
    expect(formatStatedTime(null)).toBeNull();
    expect(formatStatedTime(0)).toBeNull();
  });
});

describe("statedTimeText", () => {
  it("humanizes an ISO 8601 duration", () => {
    expect(statedTimeText("PT1H15M")).toBe("1 hr 15 min");
    expect(statedTimeText("PT45M")).toBe("45 min");
    expect(statedTimeText("PT2H")).toBe("2 hr");
    expect(statedTimeText("PT90M")).toBe("1 hr 30 min");
  });

  it("reads days and seconds", () => {
    expect(statedTimeText("P1DT2H")).toBe("26 hr");
    expect(statedTimeText("P1D")).toBe("24 hr");
    expect(statedTimeText("PT0H30M30S")).toBe("31 min");
    expect(statedTimeText(" PT20M ")).toBe("20 min");
  });

  // The backend's grammar, so humanized text always has the seconds a card shows.
  it("shows fractions and lower case as written", () => {
    expect(statedTimeText("PT1.5H")).toBe("PT1.5H");
    expect(statedTimeText(" pt20m ")).toBe(" pt20m ");
    expect(statedTimeText("PT20m")).toBe("PT20m");
  });

  it("shows any other text as written", () => {
    expect(statedTimeText("about 30 minutes")).toBe("about 30 minutes");
    expect(statedTimeText("P")).toBe("P");
    expect(statedTimeText("PT")).toBe("PT");
    expect(statedTimeText("P1M")).toBe("P1M");
  });

  it("shows a zero duration as written", () => {
    expect(statedTimeText("PT0M")).toBe("PT0M");
  });
});
