import path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { RELIABILITY } from "./config";
import { walk } from "./fs";

function main() {
  const featureRoot = path.join(process.cwd(), RELIABILITY.flow.featureRoot);
  const files = walk(featureRoot, [".ts", ".tsx"]);

  if (files.length === 0) {
    console.log("✅ ID typing check passed (no files to scan).");
    return;
  }

  const tsConfigPath = path.join(process.cwd(), "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
  });

  let hasError = false;

  for (const filePath of files) {
    const sf = project.addSourceFileAtPath(filePath);

    if (sf.getFullText().includes(RELIABILITY.ids.ignoreFileComment)) continue;

    for (const alias of sf.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) {
      const name = alias.getName();
      const typeText = alias.getTypeNode()?.getText() ?? "";
      if (RELIABILITY.ids.idNameRegex.test(name) && RELIABILITY.ids.bannedPrimitiveIdTypes.has(typeText)) {
        hasError = true;
        console.error(
          `\n❌ [Primitive ID Alias] ${path.relative(process.cwd(), filePath)}\n` +
            `   type ${name} = ${typeText}\n` +
            `   Use Convex Id<"table"> (for document IDs) or a branded type for external IDs.\n` +
            `   Convex doc IDs: import { Id } from "convex/_generated/dataModel"; (see Convex docs)\n`,
        );
      }
    }

    for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
      const name = prop.getName();
      const typeText = prop.getTypeNode()?.getText() ?? "";
      if (RELIABILITY.ids.idNameRegex.test(name) && RELIABILITY.ids.bannedPrimitiveIdTypes.has(typeText)) {
        hasError = true;
        console.error(
          `\n❌ [Primitive ID Property] ${path.relative(process.cwd(), filePath)}\n` +
            `   property "${name}: ${typeText}"\n` +
            `   Use Id<"..."> for Convex document IDs (Convex generates this type).\n`,
        );
      }
    }

    for (const param of sf.getDescendantsOfKind(SyntaxKind.Parameter)) {
      const nameNode = param.getNameNode();
      const nameText = nameNode.getText();
      const typeText = param.getTypeNode()?.getText() ?? "";

      if (nameText.startsWith("{") || nameText.startsWith("[")) continue;

      if (RELIABILITY.ids.idNameRegex.test(nameText) && RELIABILITY.ids.bannedPrimitiveIdTypes.has(typeText)) {
        hasError = true;
        console.error(
          `\n❌ [Primitive ID Parameter] ${path.relative(process.cwd(), filePath)}\n` +
            `   parameter "${nameText}: ${typeText}"\n` +
            `   Use Id<"..."> (Convex) or a branded type.\n`,
        );
      }
    }
  }

  if (hasError) process.exit(1);
  console.log(`✅ ID typing check passed (${files.length} file(s) scanned).`);
}

main();
