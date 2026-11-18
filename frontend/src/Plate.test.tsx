// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Plate } from "./Plate";

const preview = { image_id: "abc123", focal_x: 0.5, focal_y: 0.5 };
let cleanup = () => {};
afterEach(() => cleanup());

function render(size: "card" | "hero") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Plate title="Oats" size={size} preview={preview} />));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

const fail = (host: HTMLElement) =>
  act(() => host.querySelector("img")?.dispatchEvent(new Event("error")));

it("shows the card-size photo on a hero whose full photo fails, then the Empty Plate", () => {
  const host = render("hero");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/images/abc123.webp");

  fail(host);
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/images/abc123-card.webp");

  fail(host);
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toBe("O");
});

it("shows the Empty Plate on a card whose photo fails", () => {
  const host = render("card");
  fail(host);
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toBe("O");
});
