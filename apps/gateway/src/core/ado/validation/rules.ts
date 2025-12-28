import { minimatch } from "minimatch";
import type { BoundariesConfig, BoundaryGroup, BoundaryRule } from "../config/schema.js";

// ============================================================================
// Types
// ============================================================================

export interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
}

export interface BoundaryViolation {
  type: "forbidden_import" | "cross_boundary_cycle" | "public_api_violation";
  from: string;
  to: string;
  message: string;
  rule?: BoundaryRule;
}

export interface GraphMetrics {
  nodeCount: number;
  edgeCount: number;
  density: number;
  sccCount: number;
  avgOutDegree: number;
  maxOutDegree: number;
}

// ============================================================================
// Path Matching Helpers
// ============================================================================

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\//, "");
}

function matchesGroup(filePath: string, group: BoundaryGroup): boolean {
  const normalized = normalizeFilePath(filePath);

  const matchesInclude = group.includeGlobs.some((glob) =>
    minimatch(normalized, glob, { dot: true })
  );

  if (!matchesInclude) {
    return false;
  }

  if (group.excludeGlobs && group.excludeGlobs.length > 0) {
    const matchesExclude = group.excludeGlobs.some((glob) =>
      minimatch(normalized, glob, { dot: true })
    );
    if (matchesExclude) {
      return false;
    }
  }

  return true;
}

function findGroupForFile(
  filePath: string,
  groups: BoundaryGroup[]
): BoundaryGroup | undefined {
  for (const group of groups) {
    if (matchesGroup(filePath, group)) {
      return group;
    }
  }
  return undefined;
}

function isPublicApiPath(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  return (
    normalized.endsWith("/index.ts") ||
    normalized.endsWith("/index.tsx") ||
    normalized.endsWith("/index.js") ||
    normalized.endsWith("/index.jsx") ||
    /\/index\.[jt]sx?$/.test(normalized) ||
    /^[^/]+\/index\.[jt]sx?$/.test(normalized)
  );
}

function getGroupRootDir(group: BoundaryGroup): string | undefined {
  // Try to extract the common root directory from includeGlobs
  // e.g., "src/core/**" -> "src/core"
  for (const glob of group.includeGlobs) {
    const parts = glob.split("/");
    const staticParts: string[] = [];
    for (const part of parts) {
      if (part.includes("*") || part.includes("?") || part.includes("[")) {
        break;
      }
      staticParts.push(part);
    }
    if (staticParts.length > 0) {
      return staticParts.join("/");
    }
  }
  return undefined;
}

// ============================================================================
// Tarjan's SCC Algorithm
// ============================================================================

interface TarjanState {
  index: number;
  indices: Map<string, number>;
  lowlinks: Map<string, number>;
  onStack: Set<string>;
  stack: string[];
  sccs: string[][];
}

export function findSCCs(
  nodes: string[],
  edges: Map<string, string[]>
): string[][] {
  const state: TarjanState = {
    index: 0,
    indices: new Map(),
    lowlinks: new Map(),
    onStack: new Set(),
    stack: [],
    sccs: [],
  };

  function strongConnect(v: string): void {
    state.indices.set(v, state.index);
    state.lowlinks.set(v, state.index);
    state.index++;
    state.stack.push(v);
    state.onStack.add(v);

    const successors = edges.get(v) || [];
    for (const w of successors) {
      if (!state.indices.has(w)) {
        // w has not been visited
        strongConnect(w);
        state.lowlinks.set(
          v,
          Math.min(state.lowlinks.get(v)!, state.lowlinks.get(w)!)
        );
      } else if (state.onStack.has(w)) {
        // w is on the stack, so it's in the current SCC
        state.lowlinks.set(
          v,
          Math.min(state.lowlinks.get(v)!, state.indices.get(w)!)
        );
      }
    }

    // If v is a root node, pop the SCC
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
      strongConnect(node);
    }
  }

  return state.sccs;
}

// ============================================================================
// Graph Metrics
// ============================================================================

export function computeGraphMetrics(
  nodes: string[],
  edges: Map<string, string[]>
): GraphMetrics {
  const nodeCount = nodes.length;

  let edgeCount = 0;
  let maxOutDegree = 0;
  let totalOutDegree = 0;

  for (const node of nodes) {
    const outEdges = edges.get(node) || [];
    const degree = outEdges.length;
    edgeCount += degree;
    totalOutDegree += degree;
    if (degree > maxOutDegree) {
      maxOutDegree = degree;
    }
  }

  // Density for directed graph: edges / (nodes * (nodes - 1))
  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const density = maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0;

  const avgOutDegree = nodeCount > 0 ? totalOutDegree / nodeCount : 0;

  const sccs = findSCCs(nodes, edges);
  const sccCount = sccs.length;

  return {
    nodeCount,
    edgeCount,
    density,
    sccCount,
    avgOutDegree,
    maxOutDegree,
  };
}

// ============================================================================
// BoundaryChecker Class
// ============================================================================

export class BoundaryChecker {
  private config: BoundariesConfig;
  private edges: ImportEdge[];
  private groupsById: Map<string, BoundaryGroup>;
  private rulesMap: Map<string, BoundaryRule>; // "fromGroup:toGroup" -> rule

  constructor(config: BoundariesConfig, edges: ImportEdge[]) {
    this.config = config;
    this.edges = edges;
    this.groupsById = new Map(config.groups.map((g) => [g.id, g]));
    this.rulesMap = new Map();

    for (const rule of config.rules) {
      const key = `${rule.fromGroup}:${rule.toGroup}`;
      this.rulesMap.set(key, rule);
    }
  }

  /**
   * Get the group that a file belongs to
   */
  getFileGroup(filePath: string): BoundaryGroup | undefined {
    return findGroupForFile(filePath, this.config.groups);
  }

  /**
   * Get the rule that governs imports from one group to another
   */
  getRule(fromGroupId: string, toGroupId: string): BoundaryRule | undefined {
    return this.rulesMap.get(`${fromGroupId}:${toGroupId}`);
  }

  /**
   * Check if an import is allowed based on boundary rules
   */
  isImportAllowed(
    fromFile: string,
    toFile: string
  ): { allowed: boolean; rule?: BoundaryRule; reason?: string } {
    const fromGroup = this.getFileGroup(fromFile);
    const toGroup = this.getFileGroup(toFile);

    // If either file is not in a defined group, allow by default
    if (!fromGroup || !toGroup) {
      return { allowed: true };
    }

    // Same group imports are always allowed
    if (fromGroup.id === toGroup.id) {
      return { allowed: true };
    }

    // Check for an explicit rule
    const rule = this.getRule(fromGroup.id, toGroup.id);

    if (!rule) {
      // No explicit rule means allowed by default
      return { allowed: true };
    }

    if (!rule.allow) {
      return {
        allowed: false,
        rule,
        reason: `Import from group '${fromGroup.id}' to group '${toGroup.id}' is forbidden`,
      };
    }

    // Check onlyViaPublicApi constraint
    if (rule.onlyViaPublicApi) {
      const toGroupRoot = getGroupRootDir(toGroup);
      if (toGroupRoot && !isPublicApiPath(toFile)) {
        // Check if the target is directly under the group root's index
        const normalizedTo = normalizeFilePath(toFile);
        const expectedPublicApi = `${toGroupRoot}/index`;
        if (!normalizedTo.startsWith(expectedPublicApi)) {
          return {
            allowed: false,
            rule,
            reason: `Import from '${fromGroup.id}' to '${toGroup.id}' must go through public API (index.ts)`,
          };
        }
      }
    }

    return { allowed: true, rule };
  }

  /**
   * Check all edges for forbidden import violations
   */
  checkForbiddenImports(): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];

    for (const edge of this.edges) {
      const result = this.isImportAllowed(edge.from, edge.to);
      if (!result.allowed) {
        violations.push({
          type: "forbidden_import",
          from: edge.from,
          to: edge.to,
          message: result.reason || "Import is forbidden by boundary rules",
          rule: result.rule,
        });
      }
    }

    return violations;
  }

  /**
   * Check for public API violations (imports that bypass index.ts)
   */
  checkPublicApiViolations(): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];

    for (const edge of this.edges) {
      const fromGroup = this.getFileGroup(edge.from);
      const toGroup = this.getFileGroup(edge.to);

      if (!fromGroup || !toGroup || fromGroup.id === toGroup.id) {
        continue;
      }

      const rule = this.getRule(fromGroup.id, toGroup.id);

      if (rule?.onlyViaPublicApi && rule.allow) {
        if (!isPublicApiPath(edge.to)) {
          const toGroupRoot = getGroupRootDir(toGroup);
          if (toGroupRoot) {
            violations.push({
              type: "public_api_violation",
              from: edge.from,
              to: edge.to,
              message: `Import from '${fromGroup.id}' to '${toGroup.id}' bypasses public API. Should import from '${toGroupRoot}/index.ts'`,
              rule,
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check for cycles that span multiple boundary groups
   */
  checkCrossBoundaryCycles(): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];

    // Build graph from edges
    const nodes = new Set<string>();
    const edgeMap = new Map<string, string[]>();

    for (const edge of this.edges) {
      nodes.add(edge.from);
      nodes.add(edge.to);

      const existing = edgeMap.get(edge.from) || [];
      existing.push(edge.to);
      edgeMap.set(edge.from, existing);
    }

    // Find SCCs
    const sccs = findSCCs(Array.from(nodes), edgeMap);

    // Check each SCC with more than one node for cross-boundary cycles
    for (const scc of sccs) {
      if (scc.length <= 1) {
        continue;
      }

      // Get all groups in this SCC
      const groupsInScc = new Set<string>();
      for (const file of scc) {
        const group = this.getFileGroup(file);
        if (group) {
          groupsInScc.add(group.id);
        }
      }

      // If the SCC spans multiple groups, it's a cross-boundary cycle
      if (groupsInScc.size > 1) {
        // Find representative edges that cross boundaries
        for (const file of scc) {
          const fromGroup = this.getFileGroup(file);
          if (!fromGroup) continue;

          const outEdges = edgeMap.get(file) || [];
          for (const target of outEdges) {
            if (!scc.includes(target)) continue;

            const toGroup = this.getFileGroup(target);
            if (toGroup && toGroup.id !== fromGroup.id) {
              violations.push({
                type: "cross_boundary_cycle",
                from: file,
                to: target,
                message: `Cross-boundary cycle detected between groups '${fromGroup.id}' and '${toGroup.id}' (SCC size: ${scc.length})`,
              });
            }
          }
        }
      }
    }

    return violations;
  }

  /**
   * Run all boundary checks and return all violations
   */
  checkAll(): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];

    violations.push(...this.checkForbiddenImports());
    violations.push(...this.checkPublicApiViolations());
    violations.push(...this.checkCrossBoundaryCycles());

    return violations;
  }

  /**
   * Get graph metrics for the import graph
   */
  getGraphMetrics(): GraphMetrics {
    const nodes = new Set<string>();
    const edgeMap = new Map<string, string[]>();

    for (const edge of this.edges) {
      nodes.add(edge.from);
      nodes.add(edge.to);

      const existing = edgeMap.get(edge.from) || [];
      existing.push(edge.to);
      edgeMap.set(edge.from, existing);
    }

    return computeGraphMetrics(Array.from(nodes), edgeMap);
  }

  /**
   * Build a condensed graph where nodes are groups instead of files
   */
  getGroupGraph(): { nodes: string[]; edges: Map<string, Set<string>> } {
    const groupEdges = new Map<string, Set<string>>();
    const seenGroups = new Set<string>();

    for (const edge of this.edges) {
      const fromGroup = this.getFileGroup(edge.from);
      const toGroup = this.getFileGroup(edge.to);

      if (fromGroup && toGroup && fromGroup.id !== toGroup.id) {
        seenGroups.add(fromGroup.id);
        seenGroups.add(toGroup.id);

        const existing = groupEdges.get(fromGroup.id) || new Set();
        existing.add(toGroup.id);
        groupEdges.set(fromGroup.id, existing);
      }
    }

    return {
      nodes: Array.from(seenGroups),
      edges: groupEdges,
    };
  }
}

// ============================================================================
// Main Export Function
// ============================================================================

/**
 * Check all boundary rules and return violations
 */
export function checkBoundaryRules(
  config: BoundariesConfig,
  importEdges: ImportEdge[]
): BoundaryViolation[] {
  const checker = new BoundaryChecker(config, importEdges);
  return checker.checkAll();
}

// ============================================================================
// Utilities for building import edges from TypeScript analysis
// ============================================================================

/**
 * Build an edge map from import edges for graph algorithms
 */
export function buildEdgeMap(edges: ImportEdge[]): Map<string, string[]> {
  const edgeMap = new Map<string, string[]>();

  for (const edge of edges) {
    const existing = edgeMap.get(edge.from) || [];
    existing.push(edge.to);
    edgeMap.set(edge.from, existing);
  }

  return edgeMap;
}

/**
 * Get all unique nodes from import edges
 */
export function getNodesFromEdges(edges: ImportEdge[]): string[] {
  const nodes = new Set<string>();

  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
  }

  return Array.from(nodes);
}

/**
 * Filter edges to only those crossing boundary groups
 */
export function filterCrossBoundaryEdges(
  edges: ImportEdge[],
  config: BoundariesConfig
): ImportEdge[] {
  return edges.filter((edge) => {
    const fromGroup = findGroupForFile(edge.from, config.groups);
    const toGroup = findGroupForFile(edge.to, config.groups);

    return fromGroup && toGroup && fromGroup.id !== toGroup.id;
  });
}

/**
 * Group violations by type for easier reporting
 */
export function groupViolationsByType(
  violations: BoundaryViolation[]
): Map<BoundaryViolation["type"], BoundaryViolation[]> {
  const grouped = new Map<BoundaryViolation["type"], BoundaryViolation[]>();

  for (const v of violations) {
    const existing = grouped.get(v.type) || [];
    existing.push(v);
    grouped.set(v.type, existing);
  }

  return grouped;
}

/**
 * Format violations for console output
 */
export function formatViolations(violations: BoundaryViolation[]): string {
  if (violations.length === 0) {
    return "No boundary violations found.";
  }

  const lines: string[] = [`Found ${violations.length} boundary violation(s):`];
  const grouped = groupViolationsByType(violations);

  for (const [type, typeViolations] of grouped) {
    lines.push(`\n## ${type} (${typeViolations.length})`);

    for (const v of typeViolations) {
      lines.push(`  - ${v.from} -> ${v.to}`);
      lines.push(`    ${v.message}`);
    }
  }

  return lines.join("\n");
}
