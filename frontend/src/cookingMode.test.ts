import { afterEach, expect, it, vi } from "vitest";
import { isCookingModeOpen, setCookingModeOpen, subscribeCookingMode } from "./cookingMode";

afterEach(() => setCookingModeOpen(false));

it("says whether cooking mode is open and tells subscribers when that changes", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeCookingMode(listener);
  expect(isCookingModeOpen()).toBe(false);

  setCookingModeOpen(true);
  setCookingModeOpen(true);
  expect(isCookingModeOpen()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);

  unsubscribe();
  setCookingModeOpen(false);
  expect(isCookingModeOpen()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
});
