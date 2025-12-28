import * as crypto from "node:crypto";
import * as path from "node:path";

import { type HelixClient } from "../../playwright-sessions/helix-client.js";

import { loadProposal, updateProposalStatus, type FileEdit } from "./proposal.js";
import { loadSnapshot, type FileEntry, type SnapshotData } from "./snapshot.js";

/**
 * Error thrown when a proposal cannot be accepted due to validation state.
 */
export class ProposalAcceptError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "NOT_VALIDATED" | "VALIDATION_FAILED"
  ) {
    super(message);
    this.name = "ProposalAcceptError";
  }
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".sql": "sql",
    ".sh": "bash",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
  };
  return langMap[ext] ?? "text";
}

/**
 * Materializes a view by applying edits to base files.
 * Returns the merged FileEntry[] representing the final state.
 *
 * @param baseFiles - Files from the base snapshot
 * @param edits - File edits to apply
 * @returns Merged file entries with all edits applied
 */
export function materializeView(
  baseFiles: FileEntry[],
  edits: FileEdit[]
): FileEntry[] {
  // Build a map of base files by path
  const fileMap = new Map<string, FileEntry>();
  for (const file of baseFiles) {
    const normalizedPath = file.path.replace(/\\/g, "/").replace(/^\//, "");
    fileMap.set(normalizedPath, file);
  }

  // Track deleted and renamed paths
  const deletedPaths = new Set<string>();
  const renamedFrom = new Map<string, string>(); // oldPath -> newPath

  // Process edits in order
  for (const edit of edits) {
    const normalizedPath = edit.path.replace(/\\/g, "/").replace(/^\//, "");

    switch (edit.kind) {
      case "add": {
        if (edit.content === undefined) {
          throw new Error(`Add edit for ${edit.path} missing content`);
        }
        const content = edit.content;
        fileMap.set(normalizedPath, {
          path: normalizedPath,
          content,
          sha256: sha256(content),
          language: detectLanguage(normalizedPath),
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          lineCount: content.split("\n").length,
        });
        break;
      }

      case "modify": {
        if (edit.content === undefined) {
          throw new Error(`Modify edit for ${edit.path} missing content`);
        }
        const existing = fileMap.get(normalizedPath);
        if (!existing && !deletedPaths.has(normalizedPath)) {
          // File might have been added in a previous edit, or doesn't exist
          // For modify, we create/update regardless
        }
        const content = edit.content;
        fileMap.set(normalizedPath, {
          path: normalizedPath,
          content,
          sha256: sha256(content),
          language: detectLanguage(normalizedPath),
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          lineCount: content.split("\n").length,
        });
        break;
      }

      case "delete": {
        deletedPaths.add(normalizedPath);
        fileMap.delete(normalizedPath);
        break;
      }

      case "rename": {
        if (!edit.oldPath) {
          throw new Error(`Rename edit for ${edit.path} missing oldPath`);
        }
        const oldNormalized = edit.oldPath.replace(/\\/g, "/").replace(/^\//, "");

        // Get content from old path or from edit
        const oldFile = fileMap.get(oldNormalized);
        const content = edit.content ?? oldFile?.content;

        if (content === undefined) {
          throw new Error(
            `Rename edit from ${edit.oldPath} to ${edit.path} missing content and source file not found`
          );
        }

        // Remove old path
        deletedPaths.add(oldNormalized);
        fileMap.delete(oldNormalized);
        renamedFrom.set(oldNormalized, normalizedPath);

        // Add at new path
        fileMap.set(normalizedPath, {
          path: normalizedPath,
          content,
          sha256: sha256(content),
          language: detectLanguage(normalizedPath),
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          lineCount: content.split("\n").length,
        });
        break;
      }

      default:
        throw new Error(`Unknown edit kind: ${(edit as FileEdit).kind}`);
    }
  }

  // Return all files that weren't deleted
  return Array.from(fileMap.values());
}

/**
 * Accepts a validated proposal, creating a new snapshot with merged files.
 *
 * This function:
 * 1. Loads the proposal and validates it has passed validation
 * 2. Loads the base snapshot files
 * 3. Applies all proposal edits to create merged files
 * 4. Creates a new snapshot with the merged files
 * 5. Updates the proposal status to "accepted"
 * 6. Updates the repo head_snapshot_id to point to the new snapshot
 *
 * @param client - HelixClient instance
 * @param proposalId - ID of the proposal to accept
 * @returns The new SnapshotData representing the accepted state
 * @throws ProposalAcceptError if proposal not found, not validated, or validation failed
 */
export async function acceptProposal(
  client: HelixClient,
  proposalId: string
): Promise<SnapshotData> {
  // 1. Load the proposal
  const proposalResult = await loadProposal(client, proposalId);
  const { proposal, edits: editMetadata } = proposalResult;

  // 2. Check validation status - get the last ValidationRun for this proposal
  const validations = await client.getProposalValidations(proposalId);
  
  if (validations.length === 0) {
    throw new ProposalAcceptError(
      `Proposal ${proposalId} has not been validated`,
      "NOT_VALIDATED"
    );
  }

  // Sort by created_at_ms descending to get the latest validation
  const sortedValidations = [...validations].sort(
    (a, b) => (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0)
  );
  const lastValidation = sortedValidations[0];

  if (!lastValidation || lastValidation.status !== "passed") {
    throw new ProposalAcceptError(
      `Proposal ${proposalId} validation did not pass (status: ${lastValidation?.status ?? "unknown"})`,
      "VALIDATION_FAILED"
    );
  }

  // 3. Load base snapshot files
  const baseSnapshotId = proposal.baseSnapshotId;
  const { snapshot: baseSnapshot, files: baseFiles } = await loadSnapshot(
    client,
    baseSnapshotId
  );

  // 4. Load full edit content for each edit
  const editsWithContent: FileEdit[] = [];
  for (const editMeta of editMetadata) {
    if (editMeta.id) {
      const fullEdit = await client.getFileEdit(editMeta.id);
      if (fullEdit) {
        editsWithContent.push({
          id: fullEdit.id,
          editKey: fullEdit.edit_key,
          path: fullEdit.path,
          kind: fullEdit.kind as FileEdit["kind"],
          content: fullEdit.content,
          sha256: fullEdit.sha256,
          oldPath: fullEdit.old_path,
        });
      }
    }
  }

  // 5. Materialize the view (apply edits to base files)
  const mergedFiles = materializeView(baseFiles, editsWithContent);

  // 6. Get the repo
  const repo = await client.getRepoByName(proposal.repoName);
  if (!repo) {
    throw new Error(`Repo not found: ${proposal.repoName}`);
  }

  // 7. Create a new snapshot
  const snapshotKey = `snap_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const nowMs = Date.now();

  const newSnapshot = await client.createSnapshot({
    repo_id: repo.id,
    snapshot_key: snapshotKey,
    repo_name: proposal.repoName,
    parent_snapshot_id: baseSnapshotId,
    commit_sha: "", // No git commit for proposal acceptance
    now_ms: nowMs,
    metadata_json: JSON.stringify({
      source: "proposal_acceptance",
      proposalId,
      proposalKey: proposal.proposalKey,
      baseSnapshotId,
    }),
  });

  // 8. Persist all merged files to the new snapshot
  let totalBytes = 0;
  for (const file of mergedFiles) {
    const fileKey = `file_${sha256(file.path + file.sha256).slice(0, 16)}`;

    await client.createFile({
      snapshot_id: newSnapshot.id,
      file_key: fileKey,
      path: file.path,
      content: file.content,
      sha256: file.sha256,
      language: file.language,
      size_bytes: file.sizeBytes,
      line_count: file.lineCount,
      now_ms: nowMs,
    });

    totalBytes += file.sizeBytes;
  }

  // 9. Update snapshot status to complete
  await client.updateSnapshotStatus({
    snapshot_id: newSnapshot.id,
    status: "complete",
    file_count: mergedFiles.length,
    total_bytes: totalBytes,
  });

  // 10. Update proposal status to "accepted"
  await updateProposalStatus(client, proposalId, "accepted");

  // 11. Update repo head_snapshot_id to point to new snapshot
  await client.updateRepoHead({
    repo_id: repo.id,
    head_snapshot_id: newSnapshot.id,
    now_ms: nowMs,
  });

  // 12. Return the new SnapshotData
  return {
    snapshotKey: newSnapshot.snapshot_key,
    repoName: proposal.repoName,
    status: "complete",
    fileCount: mergedFiles.length,
    totalBytes,
    createdAtMs: nowMs,
    parentSnapshotId: baseSnapshotId,
    commitSha: undefined,
  };
}
