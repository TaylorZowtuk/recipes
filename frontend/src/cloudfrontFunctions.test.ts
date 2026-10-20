import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The CloudFront Functions in infra/modules/site. Their runtime has no module exports, so each
// file is evaluated as a script and its top-level `handler` pulled out.
type Headers = Record<string, { value: string }>;
type Request = { uri: string; headers: Headers };
type Response = { statusCode: number; headers: Headers };

function load<E, R>(name: string): (event: E) => R {
  const code = readFileSync(new URL(`../../infra/modules/site/${name}`, import.meta.url), "utf8");
  return new Function(`${code}\nreturn handler;`)();
}

describe("spa.js (viewer request, default behaviour)", () => {
  const spa = load<{ request: Request }, Request>("spa.js");
  const uri = (path: string) => spa({ request: { uri: path, headers: {} } }).uri;

  it("serves index.html for app routes", () => {
    expect(uri("/week")).toBe("/index.html");
    expect(uri("/recipes/abc")).toBe("/index.html");
  });

  it("serves index.html for the root", () => {
    expect(uri("/")).toBe("/index.html");
  });

  it("leaves files alone", () => {
    expect(uri("/robots.txt")).toBe("/robots.txt");
    expect(uri("/assets/x.js")).toBe("/assets/x.js");
  });
});

describe("noindex.js (viewer response, every behaviour)", () => {
  const noindex = load<{ response: Response }, Response>("noindex.js");

  it("adds X-Robots-Tag: noindex and keeps the other headers", () => {
    const response = noindex({
      response: { statusCode: 200, headers: { "content-type": { value: "text/html" } } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({
      "content-type": { value: "text/html" },
      "x-robots-tag": { value: "noindex" },
    });
  });
});
