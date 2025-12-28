import * as ts from "typescript";
import * as path from "node:path";

export interface ImportEdge {
  fromPath: string;
  toPath: string;
  specifier: string;
  kind: "import" | "export" | "dynamic" | "require";
  isTypeOnly: boolean;
}

export function extractImports(program: ts.Program, rootDir: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const checker = program.getTypeChecker();
  
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;
    
    const fromPath = normalizeToRelative(sourceFile.fileName, rootDir);
    
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const specifier = getModuleSpecifier(node.moduleSpecifier);
        if (specifier) {
          const resolved = resolveModuleSpecifier(specifier, sourceFile.fileName, program);
          if (resolved) {
            edges.push({
              fromPath,
              toPath: normalizeToRelative(resolved, rootDir),
              specifier,
              kind: "import",
              isTypeOnly: node.importClause?.isTypeOnly ?? false,
            });
          }
        }
      }
      
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const specifier = getModuleSpecifier(node.moduleSpecifier);
        if (specifier) {
          const resolved = resolveModuleSpecifier(specifier, sourceFile.fileName, program);
          if (resolved) {
            edges.push({
              fromPath,
              toPath: normalizeToRelative(resolved, rootDir),
              specifier,
              kind: "export",
              isTypeOnly: node.isTypeOnly,
            });
          }
        }
      }
      
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            const resolved = resolveModuleSpecifier(arg.text, sourceFile.fileName, program);
            if (resolved) {
              edges.push({
                fromPath,
                toPath: normalizeToRelative(resolved, rootDir),
                specifier: arg.text,
                kind: "dynamic",
                isTypeOnly: false,
              });
            }
          }
        }
        
        if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            const resolved = resolveModuleSpecifier(arg.text, sourceFile.fileName, program);
            if (resolved) {
              edges.push({
                fromPath,
                toPath: normalizeToRelative(resolved, rootDir),
                specifier: arg.text,
                kind: "require",
                isTypeOnly: false,
              });
            }
          }
        }
      }
      
      ts.forEachChild(node, visit);
    });
  }
  
  return edges.filter(e => !e.toPath.includes("node_modules") && !e.toPath.startsWith(".."));
}

function getModuleSpecifier(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function resolveModuleSpecifier(
  specifier: string,
  containingFile: string,
  program: ts.Program
): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = ts.resolveModuleName(
      specifier,
      containingFile,
      program.getCompilerOptions(),
      ts.sys
    );
    
    if (resolved.resolvedModule) {
      return resolved.resolvedModule.resolvedFileName;
    }
    
    const dir = path.dirname(containingFile);
    const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
    
    for (const ext of extensions) {
      const candidate = path.resolve(dir, specifier + ext);
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }
    }
  }
  
  return undefined;
}

function normalizeToRelative(filePath: string, rootDir: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const root = rootDir.replace(/\\/g, "/");
  
  if (normalized.startsWith(root)) {
    return normalized.slice(root.length).replace(/^\//, "");
  }
  
  return normalized;
}

export function buildAdjacencyMap(edges: ImportEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  
  for (const edge of edges) {
    const existing = map.get(edge.fromPath) ?? [];
    if (!existing.includes(edge.toPath)) {
      existing.push(edge.toPath);
    }
    map.set(edge.fromPath, existing);
    
    if (!map.has(edge.toPath)) {
      map.set(edge.toPath, []);
    }
  }
  
  return map;
}

export function getAllNodes(edges: ImportEdge[]): string[] {
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.fromPath);
    nodes.add(edge.toPath);
  }
  return Array.from(nodes);
}
