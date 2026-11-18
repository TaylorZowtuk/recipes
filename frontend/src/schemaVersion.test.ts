import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SCHEMA_VERSION } from "./schemaVersion";

it("matches the API's schema version", () => {
  const models = readFileSync(
    new URL("../../backend/src/recipes/models.py", import.meta.url),
    "utf8",
  );
  expect(models.match(/^SCHEMA_VERSION = (\d+)$/m)?.[1]).toBe(String(SCHEMA_VERSION));
});
