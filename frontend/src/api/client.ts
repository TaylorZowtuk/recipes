import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

export type Sync = components["schemas"]["Sync"];
export type Card = components["schemas"]["Card"];
export type Collection = components["schemas"]["Collection"];
export type Recipe = components["schemas"]["Recipe"];

// The PWA and the API share one origin behind CloudFront, so paths are relative.
export const api = createClient<paths>({ baseUrl: globalThis.location?.origin });
