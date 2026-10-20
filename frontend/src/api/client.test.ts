import type { Client } from "openapi-fetch";
import { describe, expect, it } from "vitest";
import { createApi } from "./client";

// sha256("") — what CloudFront expects when a POST or PUT carries no body.
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Records the request the client actually sends, after middleware has run.
function recordingApi() {
  const sent: Request[] = [];
  const fetch = async (request: Request) => {
    sent.push(request);
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  };
  // biome-ignore lint/suspicious/noExplicitAny: the schema has no POST or PUT routes yet.
  const client = createApi({ baseUrl: "https://plateful.test", fetch }) as unknown as Client<any>;
  const lastSent = () => {
    const request = sent.at(-1);
    if (!request) throw new Error("the client sent nothing");
    return request;
  };
  return { client, lastSent };
}

describe("x-amz-content-sha256", () => {
  it("hashes the exact JSON body of a POST", async () => {
    const { client, lastSent } = recordingApi();
    const body = { title: "Synthetic lentil soup", servings: 4 };
    await client.POST("/api/recipes", { body });
    const bytes = await lastSent().clone().text();
    expect(bytes).toBe(JSON.stringify(body));
    expect(lastSent().headers.get("x-amz-content-sha256")).toBe(await sha256Hex(bytes));
  });

  it("hashes the body of a PUT", async () => {
    const { client, lastSent } = recordingApi();
    await client.PUT("/api/grocery-list", { body: { items: ["2 onions"] } });
    expect(lastSent().headers.get("x-amz-content-sha256")).toBe(
      await sha256Hex(JSON.stringify({ items: ["2 onions"] })),
    );
  });

  it("sends the empty-string hash when a POST has no body", async () => {
    const { client, lastSent } = recordingApi();
    await client.POST("/api/sync", {});
    expect(lastSent().headers.get("x-amz-content-sha256")).toBe(EMPTY);
  });

  it("leaves GET requests alone", async () => {
    const { client, lastSent } = recordingApi();
    await client.GET("/api/sync", {});
    expect(lastSent().headers.has("x-amz-content-sha256")).toBe(false);
  });
});
