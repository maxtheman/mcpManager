export * from "./config/schema.js";

export * from "./agentfs/session.js";
export * from "./agentfs/interactions.js";

export * from "./code/snapshot.js";
export * from "./code/proposal.js";
export * from "./code/view.js";
export * from "./code/accept.js";

export * from "./indexer/ts-host.js";
export * from "./indexer/imports.js";

// Validation exports - ImportEdge re-exported from validate.ts shadows indexer/imports.ts
export {
  validateSnapshot,
  validateProposal,
  type ValidationResult,
  type DiagnosticInfo,
  type ImportEdge as ValidationImportEdge,
} from "./validation/validate.js";

export {
  BoundaryChecker,
  checkBoundaryRules,
  findSCCs,
  computeGraphMetrics,
  buildEdgeMap,
  getNodesFromEdges,
  filterCrossBoundaryEdges,
  groupViolationsByType,
  formatViolations,
  type ImportEdge as BoundaryImportEdge,
  type BoundaryViolation,
  type GraphMetrics,
} from "./validation/rules.js";
