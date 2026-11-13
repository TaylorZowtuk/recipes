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
export type Step = components["schemas"]["Step-Output"];
export type StepFacts = components["schemas"]["StepFacts-Output"];
export type Difficulty = components["schemas"]["Difficulty"];
export type Ingested = components["schemas"]["Ingested"];
export type NewRecipe = components["schemas"]["NewRecipe"];
export type QueuedIngest = components["schemas"]["QueuedIngest"];
export type Duplicate = components["schemas"]["Duplicate"];
export type Image = components["schemas"]["Image"];
export type Preview = components["schemas"]["Preview"];
export type RecipeOperation = components["schemas"]["RecipeEdit"]["operations"][number];
export type CountedSites = components["schemas"]["CountedSites"];
export type CountedSite = components["schemas"]["CountedSite"];
export type SiteOperation = components["schemas"]["FavoriteSitesEdit"]["operations"][number];
export type CanonicalIngredient = components["schemas"]["CanonicalIngredient-Output"];
export type KitchenSettings = components["schemas"]["KitchenSettings"];
export type StoreCategoryOperation =
  components["schemas"]["KitchenSettingsEdit"]["operations"][number];
export type WeekPlan = components["schemas"]["WeekPlan"];
export type WeekPlanEntry = components["schemas"]["WeekPlanEntry"];
export type WeekOperation = components["schemas"]["WeekPlanEdit"]["operations"][number];
export type FdcFood = components["schemas"]["FdcFood"];
export type FdcPortion = components["schemas"]["FdcPortion"];
export type Factor = components["schemas"]["ScaleAmount"]["factor"];

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
