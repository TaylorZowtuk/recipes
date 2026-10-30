import createClient, { type ClientOptions, type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Sync = components["schemas"]["Sync"];
export type Card = components["schemas"]["Card"];
export type Collection = components["schemas"]["Collection"];
export type Recipe = components["schemas"]["Recipe"];
export type Original = components["schemas"]["Original-Output"];
export type RecipeFacts = components["schemas"]["RecipeFacts-Output"];
export type ParseFact = components["schemas"]["ParseFact-Output"];
export type Quantity = components["schemas"]["Quantity"];
export type Difficulty = components["schemas"]["Difficulty"];
export type Ingested = components["schemas"]["Ingested"];
export type QueuedIngest = components["schemas"]["QueuedIngest"];
export type Duplicate = components["schemas"]["Duplicate"];
export type Image = components["schemas"]["Image"];
export type Preview = components["schemas"]["Preview"];
export type RecipeOperation = components["schemas"]["RecipeEdit"]["operations"][number];

// CloudFront signs requests to the Lambda function URL with OAC, which needs the viewer to send
// the SHA-256 of the body. Every write sends it, even without a body (which hashes the empty
// string): with SameSite=Strict, it is what stops a cross-site form from writing as an editor.
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const contentSha256: Middleware = {
  async onRequest({ request }) {
    if (!WRITES.has(request.method)) return;
    const body = await request.clone().arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    request.headers.set("x-amz-content-sha256", hex);
    return request;
  },
};

export function createApi(options: ClientOptions) {
  const client = createClient<paths>(options);
  client.use(contentSha256);
  return client;
}

// The PWA and the API share one origin behind CloudFront, so paths are relative.
export const api = createApi({ baseUrl: globalThis.location?.origin });
