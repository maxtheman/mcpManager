import * as crypto from "node:crypto";

import { type HelixClient } from "../../playwright-sessions/helix-client.js";

export type EditKind = "add" | "modify" | "delete" | "rename";

export interface FileEdit {
  id?: string;
  editKey: string;
  path: string;
  kind: EditKind;
  content?: string;
  sha256?: string;
  oldPath?: string;
}

export interface ProposalData {
  id: string;
  proposalKey: string;
  repoName: string;
  baseSnapshotId: string;
  status: string;
  editCount: number;
  createdAtMs: number;
  createdBy: string;
  title: string;
  description?: string;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function createProposal(
  client: HelixClient,
  params: {
    repoName: string;
    baseSnapshotId: string;
    title: string;
    description?: string;
    createdBy?: string;
  }
): Promise<ProposalData> {
  const repo = await client.getRepoByName(params.repoName);
  if (!repo) {
    throw new Error(`Repo not found: ${params.repoName}`);
  }
  
  const proposalKey = `prop_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const nowMs = Date.now();
  
  await client.createProposal({
    repo_id: repo.id,
    proposal_key: proposalKey,
    repo_name: params.repoName,
    base_snapshot_id: params.baseSnapshotId,
    created_by: params.createdBy ?? "ado",
    title: params.title,
    description: params.description ?? "",
    now_ms: nowMs,
    metadata_json: JSON.stringify({}),
  });
  
  return {
    id: proposalKey,
    proposalKey: proposalKey,
    repoName: params.repoName,
    baseSnapshotId: params.baseSnapshotId,
    status: "draft",
    editCount: 0,
    createdAtMs: nowMs,
    createdBy: params.createdBy ?? "ado",
    title: params.title,
    description: params.description,
  };
}

export async function addFileEdit(
  client: HelixClient,
  proposalIdOrKey: string,
  edit: Omit<FileEdit, "id" | "editKey">
): Promise<FileEdit> {
  const editKey = `edit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const contentHash = edit.content ? sha256(edit.content) : undefined;
  
  const isKey = proposalIdOrKey.startsWith("prop_");
  const proposal = isKey
    ? await client.getProposalByKey(proposalIdOrKey)
    : await client.getProposal(proposalIdOrKey);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalIdOrKey}`);
  }
  const proposalId = proposal.id;
  
  const seq = proposal.edit_count + 1;
  
  const created = await client.createFileEdit({
    proposal_id: proposalId,
    edit_key: editKey,
    path: edit.path,
    kind: edit.kind,
    content: edit.content ?? "",
    sha256: contentHash ?? "",
    old_path: edit.oldPath ?? "",
    now_ms: Date.now(),
    seq,
  });
  
  await client.updateProposalEditCount({
    proposal_id: proposalId,
    edit_count: seq,
    now_ms: Date.now(),
  });
  
  return {
    id: created.id,
    editKey: created.edit_key,
    path: created.path,
    kind: created.kind as EditKind,
    content: edit.content,
    sha256: contentHash,
    oldPath: edit.oldPath,
  };
}

export async function loadProposal(
  client: HelixClient,
  proposalIdOrKey: string
): Promise<{ proposal: ProposalData; edits: FileEdit[] }> {
  const isKey = proposalIdOrKey.startsWith("prop_");
  const proposal = isKey
    ? await client.getProposalByKey(proposalIdOrKey)
    : await client.getProposal(proposalIdOrKey);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalIdOrKey}`);
  }
  const proposalId = proposal.id;
  
  const editRecords = await client.getProposalEdits(proposalId);
  
  const edits: FileEdit[] = editRecords.map((r) => ({
    id: r.id,
    editKey: r.edit_key,
    path: r.path,
    kind: r.kind as EditKind,
    sha256: r.sha256,
  }));
  
  return {
    proposal: {
      id: proposal.id,
      proposalKey: proposal.proposal_key,
      repoName: proposal.repo_name,
      baseSnapshotId: proposal.base_snapshot_id,
      status: proposal.status,
      editCount: proposal.edit_count,
      createdAtMs: proposal.created_at_ms ?? 0,
      createdBy: proposal.created_by,
      title: proposal.title,
      description: proposal.description,
    },
    edits,
  };
}

export async function updateProposalStatus(
  client: HelixClient,
  proposalId: string,
  status: string
): Promise<void> {
  await client.updateProposalStatus({
    proposal_id: proposalId,
    status,
    now_ms: Date.now(),
  });
}

export async function listProposals(
  client: HelixClient,
  repoName: string
): Promise<ProposalData[]> {
  const repo = await client.getRepoByName(repoName);
  if (!repo) return [];
  
  const records = await client.listRepoProposals(repo.id);
  
  return records.map((r) => ({
    id: r.id,
    proposalKey: r.proposal_key,
    repoName,
    baseSnapshotId: "",
    status: r.status,
    editCount: r.edit_count,
    createdAtMs: r.created_at_ms ?? 0,
    createdBy: r.created_by,
    title: r.title,
  }));
}
