import { describe, expect, it } from "vitest";
import { cardImageUrl, clampFraction, focalAt, focalStep, imageUrl, objectPosition } from "./photo";

describe("image URLs", () => {
  it("serve the full-size copy and the card-size copy", () => {
    expect(imageUrl("abc123")).toBe("/images/abc123.webp");
    expect(cardImageUrl("abc123")).toBe("/images/abc123-card.webp");
  });
});

describe("clampFraction", () => {
  it("keeps a fraction between 0 and 1", () => {
    expect(clampFraction(-0.2)).toBe(0);
    expect(clampFraction(0.3)).toBe(0.3);
    expect(clampFraction(1.7)).toBe(1);
  });
});

describe("focalAt", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it("is the pointer's position as fractions of the photo's width and height", () => {
    expect(focalAt(200, 100, rect)).toEqual({ focal_x: 0.25, focal_y: 0.25 });
    expect(focalAt(300, 150, rect)).toEqual({ focal_x: 0.5, focal_y: 0.5 });
  });

  it("stays on the photo when the pointer is dragged off it", () => {
    expect(focalAt(0, 400, rect)).toEqual({ focal_x: 0, focal_y: 1 });
    expect(focalAt(900, -10, rect)).toEqual({ focal_x: 1, focal_y: 0 });
  });
});

describe("focalStep", () => {
  const centre = { focal_x: 0.5, focal_y: 0.5 };

  it("moves the Focal Point a step with each arrow key", () => {
    expect(focalStep(centre, "ArrowLeft")).toEqual({ focal_x: 0.45, focal_y: 0.5 });
    expect(focalStep(centre, "ArrowRight")).toEqual({ focal_x: 0.55, focal_y: 0.5 });
    expect(focalStep(centre, "ArrowUp")).toEqual({ focal_x: 0.5, focal_y: 0.45 });
    expect(focalStep(centre, "ArrowDown")).toEqual({ focal_x: 0.5, focal_y: 0.55 });
  });

  it("stops at the photo's edges", () => {
    expect(focalStep({ focal_x: 0.02, focal_y: 0.98 }, "ArrowLeft")).toEqual({
      focal_x: 0,
      focal_y: 0.98,
    });
    expect(focalStep({ focal_x: 0.02, focal_y: 0.98 }, "ArrowDown")).toEqual({
      focal_x: 0.02,
      focal_y: 1,
    });
  });

  it("ignores every other key", () => {
    expect(focalStep(centre, "Enter")).toBeUndefined();
  });
});

describe("objectPosition", () => {
  it("puts the Focal Point's fractions as percentages", () => {
    expect(objectPosition({ focal_x: 0.5, focal_y: 0.5 })).toBe("50% 50%");
    expect(objectPosition({ focal_x: 0, focal_y: 1 })).toBe("0% 100%");
  });

  it("rounds away floating-point noise", () => {
    expect(objectPosition({ focal_x: 0.1 + 0.2, focal_y: 0.123456 })).toBe("30% 12.3%");
  });
});
