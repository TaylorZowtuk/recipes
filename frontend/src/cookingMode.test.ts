import { expect, it } from "vitest";
import { isCookingModeOpen, openCookingMode } from "./cookingMode";

it("is open while any opening is unreleased, and each release counts once", () => {
  expect(isCookingModeOpen()).toBe(false);
  const first = openCookingMode();
  const second = openCookingMode();
  expect(isCookingModeOpen()).toBe(true);
  first();
  first();
  expect(isCookingModeOpen()).toBe(true);
  second();
  expect(isCookingModeOpen()).toBe(false);
});
