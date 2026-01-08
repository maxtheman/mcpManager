import path from "node:path";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import { RELIABILITY } from "./config";
import { walk } from "./fs";

function fileImportsXState(sf: SourceFile): boolean {
  const modules = sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue());
  return modules.some((m) => RELIABILITY.flow.xstateModules.includes(m as any));
}

function main() {
  const root = path.join(process.cwd(), RELIABILITY.flow.featureRoot);
  const files = walk(root, [".ts", ".tsx"]);

  if (files.length === 0) {
    console.log("✅ Flow discipline check passed (no files to scan).");
    return;
  }

  const project = new Project({
    tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  let hasError = false;

  for (const filePath of files) {
    const sf = project.addSourceFileAtPath(filePath);
    const text = sf.getFullText();

    if (text.includes(RELIABILITY.flow.ignoreFileComment)) continue;

    const hasXState = fileImportsXState(sf);

    const useEffects = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getExpression().getText() === "useEffect");

    if (useEffects.length > 0 && !text.includes(RELIABILITY.flow.allowUseEffectComment)) {
      hasError = true;
      console.error(
        `\n❌ [useEffect not allowed in features] ${path.relative(process.cwd(), filePath)}\n` +
          `   Found ${useEffects.length} useEffect call(s).\n` +
          `   Either:\n` +
          `     - move the coordination logic into an XState machine, or\n` +
          `     - add // ${RELIABILITY.flow.allowUseEffectComment} at top if this is truly non-flow glue.\n`,
      );
    }

    let foundFlowStateName: string | null = null;
    let statusBooleanCount = 0;

    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = vd.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;

      const call = init.asKindOrThrow(SyntaxKind.CallExpression);
      if (call.getExpression().getText() !== "useState") continue;

      const nameNode = vd.getNameNode();
      if (nameNode.getKind() !== SyntaxKind.ArrayBindingPattern) continue;

      const arr = nameNode.asKindOrThrow(SyntaxKind.ArrayBindingPattern);
      const first = arr.getElements()[0];
      const stateName = first?.getText() ?? "";

      if (RELIABILITY.flow.flowStateNames.some((n) => n.toLowerCase() === stateName.toLowerCase())) {
        foundFlowStateName = stateName;
      }

      if (RELIABILITY.flow.statusBooleanPrefixes.some((p) => stateName.startsWith(p))) {
        statusBooleanCount++;
      }
    }

    const triggersFlowRule =
      foundFlowStateName !== null || statusBooleanCount > RELIABILITY.flow.maxStatusBooleansWithoutXState;

    if (triggersFlowRule && !hasXState) {
      hasError = true;
      console.error(
        `\n❌ [Flow detected without XState] ${path.relative(process.cwd(), filePath)}\n` +
          `   Detected flow-like local state:\n` +
          (foundFlowStateName ? `     - useState for "${foundFlowStateName}"\n` : "") +
          (statusBooleanCount
            ? `     - ${statusBooleanCount} status boolean(s) (e.g. isSubmitting/isError/...)\n`
            : "") +
          `   Requirement: implement this flow as an XState machine.\n` +
          `   Fix: create a *.machine.ts and use @xstate/react in the UI file.\n`,
      );
    }
  }

  if (hasError) process.exit(1);
  console.log(`✅ Flow discipline check passed (${files.length} file(s) scanned).`);
}

main();
