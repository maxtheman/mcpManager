/**
 * ADO Validation Module
 * 
 * Validates TypeScript code in snapshots and proposals using the TS compiler,
 * extracts import graphs, computes metrics, and persists results to HelixDB.
 */

import * as crypto from "node:crypto";

import * as ts from "typescript";

import type { HelixClient } from "../../playwright-sessions/helix-client.js";
import { loadProposal, type FileEdit } from "../code/proposal.js";
import { loadSnapshot } from "../code/snapshot.js";
import type { VirtualFS } from "../code/view.js";
import { SnapshotView, ProposalView } from "../code/view.js";
import type { BoundariesConfig } from "../config/schema.js";
import { createProgramFromVFS } from "../indexer/ts-host.js";

import { checkBoundaryRules } from "./rules.js";

// ============================================================================
// Types
// ============================================================================

export interface DiagnosticInfo {
  path: string;
  code: string;
  category: "error" | "warning" | "message" | "suggestion";
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source: string;
}

export interface ImportEdge {
  fromPath: string;
  toPath: string;
  specifier: string;
  kind: "static" | "dynamic" | "require";
  isTypeOnly: boolean;
}

export interface ValidationResult {
  runId: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: DiagnosticInfo[];
  metrics: Record<string, number>;
}

// ============================================================================
// Diagnostic Helpers
// ============================================================================

function categoryToString(category: ts.DiagnosticCategory): DiagnosticInfo["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
    default:
      return "message";
  }
}

function extractDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  rootDir: string
): DiagnosticInfo[] {
  const result: DiagnosticInfo[] = [];

  for (const diag of diagnostics) {
    if (!diag.file) continue;

    const { line, character } = ts.getLineAndCharacterOfPosition(
      diag.file,
      diag.start ?? 0
    );

    let endLine: number | undefined;
    let endColumn: number | undefined;

    if (diag.start !== undefined && diag.length !== undefined) {
      const endPos = ts.getLineAndCharacterOfPosition(
        diag.file,
        diag.start + diag.length
      );
      endLine = endPos.line + 1;
      endColumn = endPos.character + 1;
    }

    // Normalize path relative to rootDir
    let filePath = diag.file.fileName.replace(/\\/g, "/");
    if (filePath.startsWith(rootDir)) {
      filePath = filePath.slice(rootDir.length).replace(/^\//, "");
    }

    result.push({
      path: filePath,
      code: `TS${diag.code}`,
      category: categoryToString(diag.category),
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      line: line + 1,
      column: character + 1,
      endLine,
      endColumn,
      source: "typescript",
    });
  }

  return result;
}

// ============================================================================
// Import Graph Extraction
// ============================================================================

interface RawImportInfo {
  specifier: string;
  kind: "static" | "dynamic" | "require";
  isTypeOnly: boolean;
}

function extractImportsFromSourceFile(sourceFile: ts.SourceFile): RawImportInfo[] {
  const imports: RawImportInfo[] = [];

  function visit(node: ts.Node): void {
    // Static imports: import x from 'y'
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({
          specifier: node.moduleSpecifier.text,
          kind: "static",
          isTypeOnly: node.importClause?.isTypeOnly ?? false,
        });
      }
    }

    // Export from: export { x } from 'y'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({
          specifier: node.moduleSpecifier.text,
          kind: "static",
          isTypeOnly: node.isTypeOnly ?? false,
        });
      }
    }

    // Dynamic imports: import('x')
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push({
            specifier: arg.text,
            kind: "dynamic",
            isTypeOnly: false,
          });
        }
      }

      // require('x')
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push({
            specifier: arg.text,
            kind: "require",
            isTypeOnly: false,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function resolveImportSpecifier(
  specifier: string,
  fromPath: string,
  vfs: VirtualFS
): string | null {
  // Skip external modules
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }

  // Resolve relative path
  const fromDir = fromPath.includes("/")
    ? fromPath.substring(0, fromPath.lastIndexOf("/"))
    : "";

  let resolved = specifier;

  if (specifier.startsWith("./")) {
    resolved = fromDir ? `${fromDir}/${specifier.slice(2)}` : specifier.slice(2);
  } else if (specifier.startsWith("../")) {
    const parts = fromDir.split("/");
    let spec = specifier;
    while (spec.startsWith("../")) {
      parts.pop();
      spec = spec.slice(3);
    }
    resolved = parts.length > 0 ? `${parts.join("/")}/${spec}` : spec;
  }

  // Normalize path
  resolved = resolved.replace(/\\/g, "/").replace(/\/+/g, "/");

  // Try various extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
  
  for (const ext of extensions) {
    const candidate = resolved.endsWith(ext) ? resolved : resolved + ext;
    if (vfs.fileExists(candidate)) {
      return candidate;
    }
  }

  // Try without extension changes (exact match)
  if (vfs.fileExists(resolved)) {
    return resolved;
  }

  return null;
}

function extractImportGraph(
  program: ts.Program,
  vfs: VirtualFS,
  rootDir: string
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const sourceFiles = program.getSourceFiles();

  for (const sourceFile of sourceFiles) {
    // Skip lib files and node_modules
    const fileName = sourceFile.fileName.replace(/\\/g, "/");
    if (fileName.includes("/node_modules/") || fileName.includes("/lib.")) {
      continue;
    }

    // Normalize path relative to rootDir
    let fromPath = fileName;
    if (fromPath.startsWith(rootDir)) {
      fromPath = fromPath.slice(rootDir.length).replace(/^\//, "");
    }

    const rawImports = extractImportsFromSourceFile(sourceFile);

    for (const imp of rawImports) {
      const toPath = resolveImportSpecifier(imp.specifier, fromPath, vfs);
      if (toPath) {
        edges.push({
          fromPath,
          toPath,
          specifier: imp.specifier,
          kind: imp.kind,
          isTypeOnly: imp.isTypeOnly,
        });
      }
    }
  }

  return edges;
}

// ============================================================================
// Tarjan's SCC Algorithm
// ============================================================================

interface TarjanState {
  index: number;
  stack: string[];
  indices: Map<string, number>;
  lowlinks: Map<string, number>;
  onStack: Set<string>;
  sccs: string[][];
}

function tarjanSCC(
  nodes: Set<string>,
  adjacency: Map<string, Set<string>>
): string[][] {
  const state: TarjanState = {
    index: 0,
    stack: [],
    indices: new Map(),
    lowlinks: new Map(),
    onStack: new Set(),
    sccs: [],
  };

  function strongconnect(v: string): void {
    state.indices.set(v, state.index);
    state.lowlinks.set(v, state.index);
    state.index++;
    state.stack.push(v);
    state.onStack.add(v);

    const neighbors = adjacency.get(v) ?? new Set();
    for (const w of neighbors) {
      if (!state.indices.has(w)) {
        strongconnect(w);
        state.lowlinks.set(
          v,
          Math.min(state.lowlinks.get(v)!, state.lowlinks.get(w)!)
        );
      } else if (state.onStack.has(w)) {
        state.lowlinks.set(
          v,
          Math.min(state.lowlinks.get(v)!, state.indices.get(w)!)
        );
      }
    }

    if (state.lowlinks.get(v) === state.indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = state.stack.pop()!;
        state.onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      state.sccs.push(scc);
    }
  }

  for (const node of nodes) {
    if (!state.indices.has(node)) {
      strongconnect(node);
    }
  }

  return state.sccs;
}

// ============================================================================
// Metrics Computation
// ============================================================================

function computeMetrics(
  files: string[],
  edges: ImportEdge[]
): Record<string, number> {
  const fileCount = files.length;
  const importEdgeCount = edges.length;

  // Build adjacency for SCC calculation
  const nodes = new Set<string>(files);
  const adjacency = new Map<string, Set<string>>();

  for (const file of files) {
    adjacency.set(file, new Set());
  }

  for (const edge of edges) {
    const from = adjacency.get(edge.fromPath);
    if (from && nodes.has(edge.toPath)) {
      from.add(edge.toPath);
    }
  }

  // Compute SCCs using Tarjan's algorithm
  const sccs = tarjanSCC(nodes, adjacency);
  const sccCount = sccs.length;

  // Graph density: edges / (nodes * (nodes - 1))
  // For directed graphs, max edges = n * (n-1)
  const maxEdges = fileCount > 1 ? fileCount * (fileCount - 1) : 1;
  const graphDensity = importEdgeCount / maxEdges;

  // Count non-trivial SCCs (size > 1, indicating cycles)
  const cyclicSccCount = sccs.filter((scc) => scc.length > 1).length;

  return {
    file_count: fileCount,
    import_edge_count: importEdgeCount,
    graph_density: Math.round(graphDensity * 10000) / 10000,
    scc_count: sccCount,
    cyclic_scc_count: cyclicSccCount,
    avg_out_degree: fileCount > 0 ? Math.round((importEdgeCount / fileCount) * 10000) / 10000 : 0,
  };
}

// ============================================================================
// Persistence
// ============================================================================

async function persistValidationRun(
  client: HelixClient,
  targetId: string,
  targetType: "snapshot" | "proposal",
  diagnostics: DiagnosticInfo[],
  edges: ImportEdge[],
  metrics: Record<string, number>,
  fileIdMap: Map<string, string>
): Promise<string> {
  const nowMs = Date.now();
  const validationKey = `val_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  const errorCount = diagnostics.filter((d) => d.category === "error").length;
  const warningCount = diagnostics.filter((d) => d.category === "warning").length;

  // Create validation run
  const run = await client.createValidationRun({
    target_id: targetId,
    target_type: targetType,
    validation_key: validationKey,
    tool_versions_json: JSON.stringify({
      typescript: ts.version,
    }),
    now_ms: nowMs,
  });

  // Link validation to target
  if (targetType === "snapshot") {
    await client.linkValidationToSnapshot({
      snapshot_id: targetId,
      validation_id: run.id,
      now_ms: nowMs,
    });
  } else {
    await client.linkValidationToProposal({
      proposal_id: targetId,
      validation_id: run.id,
      now_ms: nowMs,
    });
  }

  // Persist diagnostics
  for (let i = 0; i < diagnostics.length; i++) {
    const diag = diagnostics[i]!;
    const diagKey = `diag_${crypto.randomBytes(6).toString("hex")}`;

    await client.createDiagnostic({
      validation_id: run.id,
      diagnostic_key: diagKey,
      path: diag.path,
      code: diag.code,
      category: diag.category,
      message: diag.message,
      line: diag.line,
      column: diag.column,
      end_line: diag.endLine ?? diag.line,
      end_column: diag.endColumn ?? diag.column,
      source: diag.source,
      seq: i + 1,
    });
  }

  // Persist metrics
  for (const [name, value] of Object.entries(metrics)) {
    const metricKey = `metric_${crypto.randomBytes(6).toString("hex")}`;

    await client.createMetric({
      validation_id: run.id,
      metric_key: metricKey,
      name,
      value,
      unit: name === "graph_density" ? "ratio" : "count",
      metadata_json: JSON.stringify({}),
      now_ms: nowMs,
    });
  }

  // Persist import edges
  for (const edge of edges) {
    const fromFileId = fileIdMap.get(edge.fromPath);
    const toFileId = fileIdMap.get(edge.toPath);

    if (fromFileId && toFileId) {
      await client.createImport({
        from_file_id: fromFileId,
        to_file_id: toFileId,
        specifier: edge.specifier,
        kind: edge.kind,
        is_type_only: edge.isTypeOnly,
      });
    }
  }

  // Update validation status
  await client.updateValidationStatus({
    validation_id: run.id,
    status: errorCount > 0 ? "failed" : "passed",
    error_count: errorCount,
    warning_count: warningCount,
    metrics_json: JSON.stringify(metrics),
    completed_at_ms: Date.now(),
  });

  return run.id;
}

// ============================================================================
// Core Validation Logic
// ============================================================================

async function validateVFS(
  client: HelixClient,
  vfs: VirtualFS,
  targetId: string,
  targetType: "snapshot" | "proposal",
  fileIdMap: Map<string, string>,
  tsconfigPath: string,
  rootDir: string,
  boundaries?: BoundariesConfig
): Promise<ValidationResult> {
  // Create TypeScript program from VFS
  const program = createProgramFromVFS(vfs, tsconfigPath, rootDir);

  // Collect diagnostics
  const allDiagnostics = ts.getPreEmitDiagnostics(program);
  const diagnostics = extractDiagnostics(allDiagnostics, rootDir);

  // Extract import graph
  const edges = extractImportGraph(program, vfs, rootDir);

  if (boundaries) {
    const boundaryEdges = edges.map((edge) => ({
      from: edge.fromPath,
      to: edge.toPath,
      specifier: edge.specifier,
    }));
    const violations = checkBoundaryRules(boundaries, boundaryEdges);

    for (const violation of violations) {
      diagnostics.push({
        path: violation.from,
        code: `BOUNDARY_${violation.type.toUpperCase()}`,
        category: "error",
        message: violation.message,
        line: 1,
        column: 1,
        source: "boundary",
      });
    }
  }

  // Get list of TS files for metrics
  const tsFiles = vfs
    .listFiles()
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

  // Compute metrics
  const metrics = computeMetrics(tsFiles, edges);

  // Persist to HelixDB
  const runId = await persistValidationRun(
    client,
    targetId,
    targetType,
    diagnostics,
    edges,
    metrics,
    fileIdMap
  );

  const errorCount = diagnostics.filter((d) => d.category === "error").length;
  const warningCount = diagnostics.filter((d) => d.category === "warning").length;

  return {
    runId,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    diagnostics,
    metrics,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Validate a snapshot using the TypeScript compiler.
 * Collects diagnostics, extracts import graph, computes metrics,
 * and persists results to HelixDB.
 */
export async function validateSnapshot(
  client: HelixClient,
  snapshotId: string,
  options?: {
    tsconfigPath?: string;
    boundaries?: BoundariesConfig;
  }
): Promise<ValidationResult> {
  // Load snapshot files
  const { files } = await loadSnapshot(client, snapshotId);

  // Build file ID map for import edge persistence
  const fileRecords = await client.getSnapshotFilesByKey(snapshotId);
  const fileIdMap = new Map<string, string>();
  for (const record of fileRecords) {
    fileIdMap.set(record.path, record.id);
  }

  // Create VFS from snapshot
  const vfs = new SnapshotView(files, "/");

  // Virtual root directory for path normalization
  const rootDir = "/virtual";

  const tsconfigPath = options?.tsconfigPath ?? "tsconfig.json";
  return validateVFS(
    client,
    vfs,
    snapshotId,
    "snapshot",
    fileIdMap,
    tsconfigPath,
    rootDir,
    options?.boundaries
  );
}

/**
 * Validate a proposal by applying its edits to the base snapshot
 * and running TypeScript validation on the result.
 */
export async function validateProposal(
  client: HelixClient,
  proposalId: string,
  options?: {
    tsconfigPath?: string;
    boundaries?: BoundariesConfig;
  }
): Promise<ValidationResult> {
  // Load proposal and its base snapshot
  const { proposal } = await loadProposal(client, proposalId);
  const { files: baseFiles } = await loadSnapshot(client, proposal.baseSnapshotId);

  // Load file content for edits
  const editRecords = await client.getProposalEdits(proposal.id);
  const editsWithContent: FileEdit[] = [];

  for (const editRecord of editRecords) {
    const fullEdit = await client.getFileEdit(editRecord.id);
    if (fullEdit) {
      editsWithContent.push({
        editKey: fullEdit.edit_key,
        path: fullEdit.path,
        kind: fullEdit.kind as "add" | "modify" | "delete" | "rename",
        content: fullEdit.content,
        sha256: fullEdit.sha256,
        oldPath: fullEdit.old_path,
      });
    }
  }

  // Build file ID map from base snapshot
  const baseFileRecords = await client.getSnapshotFilesByKey(proposal.baseSnapshotId);
  const fileIdMap = new Map<string, string>();
  for (const record of baseFileRecords) {
    fileIdMap.set(record.path, record.id);
  }

  // Create VFS from proposal (base + edits)
  const vfs = new ProposalView(baseFiles, editsWithContent, "/");

  // Virtual root directory
  const rootDir = "/virtual";

  const tsconfigPath = options?.tsconfigPath ?? "tsconfig.json";
  return validateVFS(
    client,
    vfs,
    proposalId,
    "proposal",
    fileIdMap,
    tsconfigPath,
    rootDir,
    options?.boundaries
  );
}
