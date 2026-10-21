import createClient, { type ClientOptions, type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Sync = components["schemas"]["Sync"];
export type Card = components["schemas"]["Card"];
export type Collection = components["schemas"]["Collection"];
export type Recipe = components["schemas"]["Recipe"];

// CloudFront signs requests to the Lambda function URL with OAC, which needs the viewer to send
// the SHA-256 of the body on POST and PUT. An empty body hashes the empty string.
const contentSha256: Middleware = {
  async onRequest({ request }) {
    if (request.method !== "POST" && request.method !== "PUT") return;
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
