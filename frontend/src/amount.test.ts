import { describe, expect, it } from "vitest";
import { formatAmount, formatQuantity } from "./amount";

describe("formatQuantity", () => {
  it("writes kitchen fractions and ranges", () => {
    expect(formatQuantity({ low: 1.5, high: 1.5 })).toBe("1½");
    expect(formatQuantity({ low: 0.25, high: 0.25 })).toBe("¼");
    expect(formatQuantity({ low: 0.75, high: 0.75 })).toBe("¾");
    expect(formatQuantity({ low: 1 / 3, high: 1 / 3 })).toBe("⅓");
    expect(formatQuantity({ low: 0.125, high: 0.125 })).toBe("⅛");
    expect(formatQuantity({ low: 1.125, high: 1.125 })).toBe("1⅛");
    expect(formatQuantity({ low: 0.375, high: 0.375 })).toBe("⅜");
    expect(formatQuantity({ low: 2.625, high: 2.625 })).toBe("2⅝");
    expect(formatQuantity({ low: 0.875, high: 0.875 })).toBe("⅞");
    expect(formatQuantity({ low: 2, high: 2 })).toBe("2");
    expect(formatQuantity({ low: 1, high: 2 })).toBe("1–2");
    expect(formatQuantity({ low: 0.5, high: 1 })).toBe("½–1");
  });

  it("keeps an amount with no kitchen fraction as a short decimal", () => {
    expect(formatQuantity({ low: 1.15, high: 1.15 })).toBe("1.15");
  });
});

describe("formatAmount", () => {
  it("writes cups in the plural above one", () => {
    expect(formatAmount({ low: 8, high: 8 }, "cup")).toBe("8 cups");
    expect(formatAmount({ low: 1, high: 2 }, "cup")).toBe("1–2 cups");
    expect(formatAmount({ low: 1, high: 1 }, "cup")).toBe("1 cup");
    expect(formatAmount({ low: 0.75, high: 0.75 }, "cup")).toBe("¾ cup");
  });

  it("leaves other units as stored, and a count without one", () => {
    expect(formatAmount({ low: 2, high: 2 }, "tbsp")).toBe("2 tbsp");
    expect(formatAmount({ low: 3, high: 3 }, "cloves")).toBe("3 cloves");
    expect(formatAmount({ low: 2, high: 2 }, null)).toBe("2");
  });
});
