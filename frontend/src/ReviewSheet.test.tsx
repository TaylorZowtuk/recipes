// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ItemSheet } from "./ReviewSheet";
import { type EnrichmentIssue, reviewOf } from "./review";
import { collection, recipe } from "./review.fixtures";

it("accepts a line's correction without the fact only an ask is on, which only an edit settles", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  const r = recipe();
  const [correction] = r.issues as [EnrichmentIssue];
  const ask = {
    ...correction,
    id: "01K7TESTISSUE000000000009",
    fact_id: "i1.conversion",
    before: null,
    after: null,
    reason: "None of its portions fits its unit, so this line has no weight: pick a portion.",
  } as EnrichmentIssue;
  const asked = recipe({ issues: [{ ...correction, fact_id: "i1.parse" }, ask] });
  const onConfirm = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ItemSheet
        item={reviewOf(asked).get("i1")}
        recipe={asked}
        collection={collection}
        disabled={false}
        onConfirm={onConfirm}
        onEdit={vi.fn()}
        onClose={() => {}}
      />,
    ),
  );

  const accept = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Accept correction",
  );
  await act(async () => accept?.click());

  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(["i1.parse", "i1.match"]);
  act(() => root.unmount());
  host.remove();
});
