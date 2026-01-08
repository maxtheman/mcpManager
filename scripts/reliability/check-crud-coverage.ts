import path from "node:path";
import { Project } from "ts-morph";
import { RELIABILITY } from "./config";
import { exists, isDir } from "./fs";
import { getConvexTableNames } from "./getConvexTables";

async function main() {
  const schemaPath = path.join(process.cwd(), "convex", "schema.ts");
  if (!exists(schemaPath)) {
    console.log("⚠️  No convex/schema.ts found. Skipping CRUD/UI coverage check.");
    return;
  }

  const tables = await getConvexTableNames();

  let hasError = false;
  const errors: string[] = [];

  const tsConfigPath = path.join(process.cwd(), "tsconfig.json");
  const project = exists(tsConfigPath)
    ? new Project({ tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: true })
    : new Project();

  for (const table of tables) {
    const backendPath = path.join(process.cwd(), RELIABILITY.crud.backendDir, `${table}.ts`);
    if (!exists(backendPath)) {
      hasError = true;
      errors.push(
        `❌ Missing backend module for table "${table}": expected ${path.relative(process.cwd(), backendPath)}`,
      );
    } else {
      const sf = project.addSourceFileAtPath(backendPath);
      const exported = sf.getExportedDeclarations();
      for (const exp of RELIABILITY.crud.requiredBackendExports) {
        if (!exported.has(exp)) {
          hasError = true;
          errors.push(
            `❌ Backend module ${path.relative(process.cwd(), backendPath)} missing export "${exp}" (required by convention)`,
          );
        }
      }
    }

    const featureDir = path.join(process.cwd(), RELIABILITY.crud.uiDir, table);
    if (!isDir(featureDir)) {
      hasError = true;
      errors.push(
        `❌ Missing UI feature folder for table "${table}": expected ${path.relative(process.cwd(), featureDir)}/`,
      );
    } else {
      for (const fileName of RELIABILITY.crud.requiredUiFiles) {
        const filePath = path.join(featureDir, fileName);
        if (!exists(filePath)) {
          hasError = true;
          errors.push(
            `❌ Missing UI file for table "${table}": expected ${path.relative(process.cwd(), filePath)}`,
          );
        }
      }
    }
  }

  if (hasError) {
    console.error("\n🧱 CRUD/UI coverage check FAILED:\n");
    for (const e of errors) console.error(e);
    console.error(`\nTables discovered from convex/schema.ts: ${tables.join(", ") || "(none)"}`);
    process.exit(1);
  } else {
    console.log(`✅ CRUD/UI coverage check passed (${tables.length} table(s)).`);
  }
}

void main();
