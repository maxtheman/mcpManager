import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RELIABILITY } from "./config";

export async function getConvexTableNames(): Promise<string[]> {
  const schemaPath = path.join(process.cwd(), "convex", "schema.ts");

  if (!fs.existsSync(schemaPath)) {
    return [];
  }

  const mod = await import(pathToFileURL(schemaPath).href);
  const schema = mod.default;

  const tables = schema?.tables;
  if (!tables || typeof tables !== "object") {
    throw new Error(
      `Could not read schema.tables from ${schemaPath}. ` +
        `Make sure convex/schema.ts default-exports defineSchema({...}).`,
    );
  }

  const names = Object.keys(tables)
    .filter((t) => !RELIABILITY.crud.skipTables.includes(t))
    .sort();

  return names;
}
