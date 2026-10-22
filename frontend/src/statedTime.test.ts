import { describe, expect, it } from "vitest";
import { formatStatedTime } from "./statedTime";

describe("formatStatedTime", () => {
  it("shows minutes under an hour", () => {
    expect(formatStatedTime(45 * 60)).toBe("45 min");
  });

  it("shows hours and minutes", () => {
    expect(formatStatedTime(75 * 60)).toBe("1 h 15 min");
  });

  it("leaves out the minutes on the hour", () => {
    expect(formatStatedTime(3 * 3600)).toBe("3 h");
  });

  it("rounds to the nearest minute, and never down to nothing", () => {
    expect(formatStatedTime(89)).toBe("1 min");
    expect(formatStatedTime(20)).toBe("1 min");
    expect(formatStatedTime(3599)).toBe("1 h");
  });

  it("is nothing when the source gave no time", () => {
    expect(formatStatedTime(null)).toBeNull();
    expect(formatStatedTime(0)).toBeNull();
  });
});
