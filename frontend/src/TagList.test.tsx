import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TagList } from "./TagList";

// The text of each chip, in order, without any text only screen readers hear.
function chips(markup: string): string[] {
  return [...markup.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(([, inner = ""]) =>
    inner.replace(/<span class="visually-hidden">.*?<\/span>/g, ""),
  );
}

const six = ["weeknight", "vegetarian", "noodles", "spicy", "make ahead", "lunchbox"];

describe("TagList", () => {
  it("shows every Tag in stored order when there are no more than the limit", () => {
    const tags = ["weeknight", "vegetarian", "noodles", "spicy"];
    expect(chips(renderToStaticMarkup(<TagList tags={tags} limit={4} />))).toEqual(tags);
  });

  it("shows the first four Tags and how many more there are", () => {
    const markup = renderToStaticMarkup(<TagList tags={six} limit={4} />);
    expect(chips(markup)).toEqual(["weeknight", "vegetarian", "noodles", "spicy", "+2"]);
    expect(markup).toContain('+2<span class="visually-hidden"> more tags</span>');
  });

  it("shows every Tag without a limit", () => {
    expect(chips(renderToStaticMarkup(<TagList tags={six} />))).toEqual(six);
  });

  it("renders nothing for a recipe without Tags", () => {
    expect(renderToStaticMarkup(<TagList tags={[]} limit={4} />)).toBe("");
  });
});
