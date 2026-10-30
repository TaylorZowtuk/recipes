import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhotoPicker } from "./RecipeFields";

describe("PhotoPicker", () => {
  const picker = (emptyText?: string) =>
    renderToStaticMarkup(
      <PhotoPicker
        title="Soup"
        images={[]}
        preview={null}
        onPick={() => {}}
        {...(emptyText && { emptyText })}
      />,
    );

  it("says no photos were found when a search finds none", () => {
    expect(picker()).toContain("No photos were found.");
  });

  it("says what Edit tells it when the recipe has none", () => {
    expect(picker("This recipe has no photos.")).toContain("This recipe has no photos.");
  });
});
