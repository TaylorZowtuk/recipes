import type { Collection, Recipe } from "./api/client";

// A synthetic recipe Awaiting Review and its Collection, for the review tests.

export const stamp = (confirmed: boolean) => ({
  provenance: "llm" as const,
  confidence: 0.7,
  estimated: false,
  confirmed,
  confirmed_by: confirmed ? "editor" : null,
  confirmed_at: confirmed ? "2026-11-01T00:00:00Z" : null,
  confirm_batch: confirmed ? "01K7TESTBATCH0000000000000" : null,
});

export const parse = (name: string, confirmed = false, unit: string | null = null) => ({
  ...stamp(confirmed),
  provenance: "parser" as const,
  confidence: 0.9,
  quantity: { low: 2, high: 2 },
  unit,
  unit_kind: null,
  name,
  short_name: null,
  preparation: null,
  comment: null,
  optional: false,
});

// Real FDC Snapshot foods, as the seed uses: butter by the tablespoon, garlic by the clove.
export const BUTTER = { fdcId: 173410, tbsp: 92457, cup: 92458 };
export const GARLIC = { fdcId: 169230, clove: 84480 };

export const per100g = { kcal: 700, protein_g: 1, fat_g: 80, carbs_g: 0, sodium_mg: 600 };
export const conversion = (confirmed: boolean, fields: object) => ({
  ...stamp(confirmed),
  provenance: "fdc" as const,
  confidence: 0.8,
  fdc_id: BUTTER.fdcId,
  dataset: "sr_legacy" as const,
  release: "2018-04",
  density_g_per_ml: null,
  grams_per_count: null,
  count_unit: null,
  refused: null,
  per_100g: per100g,
  ...fields,
});

export const NEW_CANONICAL = "01K7TESTCANON0000000000001";
export const KNOWN_CANONICAL = "01K7TESTCANON0000000000002";
export const match = (
  canonical_id: string,
  confirmed: boolean,
  fdc_id = BUTTER.fdcId,
  portion_id: number | null = BUTTER.tbsp,
) => ({ ...stamp(confirmed), canonical_id, fdc_id, portion_id });

// A synthetic recipe Awaiting Review: i1 flagged on its match to a new Canonical Ingredient, i2
// confirmed, i3 and its substitutions unchecked, i4 with no facts, s1 unchecked, and a suggestion.
export const recipe = (fields: Partial<Recipe> = {}): Recipe =>
  ({
    id: "01K7TEST000000000000000001",
    version: 4,
    status: "awaiting_review",
    difficulty: null,
    tags: [],
    images: [],
    preview: null,
    original: {
      title: "Synthetic Test Beans",
      description: null,
      author: null,
      extractor: "json-ld",
      ingredients: [
        { id: "i1", text: "2 tbsp butter", component: null },
        { id: "i2", text: "2 cloves garlic", component: null },
        { id: "i3", text: "2 cups flour or rice flour", component: null },
        { id: "i4", text: "salt", component: null },
      ],
      steps: [
        { id: "s1", text: "Melt the butter.", component: null },
        { id: "s2", text: "Serve.", component: null },
      ],
      yield: null,
      stated_times: { prep: null, cook: null, total: null },
    },
    facts: {
      ingredients: {
        i1: {
          parse: parse("butter", false, "tbsp"),
          match: match(NEW_CANONICAL, false),
          conversion: conversion(false, { density_g_per_ml: 0.96 }),
          substitutions: null,
        },
        i2: {
          parse: parse("garlic", true, "cloves"),
          match: match(KNOWN_CANONICAL, true, GARLIC.fdcId, GARLIC.clove),
          conversion: conversion(true, {
            fdc_id: GARLIC.fdcId,
            refused: "no weight per clove in FDC",
          }),
          substitutions: null,
        },
        i3: {
          parse: parse("flour", false, "cups"),
          match: null,
          conversion: null,
          substitutions: {
            ...stamp(false),
            items: [
              {
                wording: "rice flour",
                canonical_id: KNOWN_CANONICAL,
                ratio: 0.75,
                note: "use a little less",
                fdc_id: 2,
                portion_id: null,
                fdc: {
                  dataset: "foundation",
                  release: "2025-04",
                  per_100g: per100g,
                  density_g_per_ml: 0.5,
                  count_unit: null,
                  grams_per_count: null,
                  refused: null,
                },
              },
            ],
          },
        },
        i4: { parse: null, match: null, conversion: null, substitutions: null },
      },
      steps: {
        s1: {
          segments: {
            ...stamp(false),
            segments: [
              { t: "text", v: "Melt " },
              { t: "ingredient", ref: "i1", written: "the butter", portion: 1 },
              { t: "text", v: "." },
            ],
          },
          uses: { ...stamp(false), uses: [{ ref: "i1", portion: 1 }] },
        },
      },
      difficulty: { ...stamp(false), prep: 2, cook: 1, cleanup: 1 },
    },
    issues: [
      {
        id: "01K7TESTISSUE000000000001",
        fact_id: "i1.match",
        before: "margarine",
        after: "butter",
        reason: "The line says butter.",
        status: "open",
        confirm_batch: null,
        model: "test",
      },
      {
        id: "01K7TESTISSUE000000000002",
        fact_id: "i2.parse",
        before: "garlics",
        after: "garlic",
        reason: "Already settled.",
        status: "resolved",
        confirm_batch: "01K7TESTBATCH0000000000000",
        model: "test",
      },
    ],
    ...fields,
  }) as Recipe;

export const collection = {
  canonical_ingredients: [
    {
      id: NEW_CANONICAL,
      name: "butter",
      family: "dairy",
      store_category_id: "dairy-eggs",
      pantry_staple: false,
      confirmed: false,
      confirm_batch: null,
      schema_version: 1,
      version: 1,
    },
    {
      id: KNOWN_CANONICAL,
      name: "garlic",
      family: "allium",
      store_category_id: "produce",
      pantry_staple: false,
      confirmed: true,
      confirm_batch: null,
      schema_version: 1,
      version: 1,
    },
  ],
  kitchen_settings: {
    schema_version: 1,
    version: 1,
    store_categories: [
      { id: "produce", name: "Produce" },
      { id: "dairy-eggs", name: "Dairy & Eggs" },
    ],
  },
  wordings: [],
  cards: [],
  collection_version: 1,
} as unknown as Collection;
