import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { HelixClient } from "../../playwright-sessions/helix-client.js";
import type { AdoConfig } from "../config/schema.js";
import { minimatch } from "minimatch";

export interface FileEntry {
  path: string;
  content: string;
  sha256: string;
  language: string;
  sizeBytes: number;
  lineCount: number;
}

export interface SnapshotData {
  snapshotKey: string;
  repoName: string;
  status: string;
  fileCount: number;
  totalBytes: number;
  createdAtMs: number;
  parentSnapshotId?: string;
  commitSha?: string;
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

function shouldInclude(
  filePath: string,
  includeGlobs: string[],
  excludeGlobs: string[]
): boolean {
  const relativePath = filePath.replace(/\\/g, "/");
  
  const excluded = excludeGlobs.some((glob) => minimatch(relativePath, glob));
  if (excluded) return false;
  
  const included = includeGlobs.some((glob) => minimatch(relativePath, glob));
  return included;
}

function walkDirectory(
  dir: string,
  baseDir: string,
  includeGlobs: string[],
  excludeGlobs: string[]
): FileEntry[] {
  const entries: FileEntry[] = [];
  
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    
    if (item.isDirectory()) {
      if (item.name === "node_modules" || item.name === ".git" || item.name === "dist") {
        continue;
      }
      entries.push(...walkDirectory(fullPath, baseDir, includeGlobs, excludeGlobs));
    } else if (item.isFile()) {
      if (shouldInclude(relativePath, includeGlobs, excludeGlobs)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          entries.push({
            path: relativePath,
            content,
            sha256: sha256(content),
            language: detectLanguage(relativePath),
            sizeBytes: Buffer.byteLength(content, "utf-8"),
            lineCount: content.split("\n").length,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }
  
  return entries;
}

function addExtraFile(
  entries: FileEntry[],
  repoRoot: string,
  relativePath: string
): void {
  const normalized = relativePath.replace(/\\/g, "/");
  if (entries.some((entry) => entry.path === normalized)) {
    return;
  }

  const absolutePath = path.resolve(repoRoot, normalized);
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    return;
  }

  const content = fs.readFileSync(absolutePath, "utf-8");
  entries.push({
    path: normalized,
    content,
    sha256: sha256(content),
    language: detectLanguage(normalized),
    sizeBytes: Buffer.byteLength(content, "utf-8"),
    lineCount: content.split("\n").length,
  });
}

export async function createSnapshotFromWorkingTree(
  client: HelixClient,
  config: AdoConfig,
  options?: { commitSha?: string; parentSnapshotId?: string }
): Promise<SnapshotData> {
  const repoRoot = path.resolve(config.repoRoot);
  
  const repo = await client.getRepoByName(config.repoName);
  if (!repo) {
    await client.createRepo({
      repo_name: config.repoName,
      root_path: repoRoot,
      config_json: JSON.stringify(config),
      now_ms: Date.now(),
    });
  }
  
  const snapshotKey = `snap_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const nowMs = Date.now();
  
  await client.createSnapshotByRepoName({
    repo_name: config.repoName,
    snapshot_key: snapshotKey,
    parent_snapshot_id: options?.parentSnapshotId ?? "",
    commit_sha: options?.commitSha ?? "",
    now_ms: nowMs,
    metadata_json: JSON.stringify({ source: "working_tree" }),
    status: "complete",
  });
  
  const files = walkDirectory(
    repoRoot,
    repoRoot,
    config.includeGlobs,
    config.excludeGlobs
  );

  const extraFiles = new Set<string>([
    config.tsconfigPath,
    "package.json",
  ]);

  for (const extra of extraFiles) {
    if (extra) {
      addExtraFile(files, repoRoot, extra);
    }
  }
  
  let totalBytes = 0;
  for (const file of files) {
    const fileKey = `file_${sha256(file.path + file.sha256).slice(0, 16)}`;
    
    await client.addFileToSnapshotByKey({
      snapshot_key: snapshotKey,
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
  
  return {
    snapshotKey,
    repoName: config.repoName,
    status: "complete",
    fileCount: files.length,
    totalBytes,
    createdAtMs: nowMs,
    parentSnapshotId: options?.parentSnapshotId,
    commitSha: options?.commitSha,
  };
}

export async function loadSnapshot(
  client: HelixClient,
  snapshotKey: string
): Promise<{ snapshot: SnapshotData; files: FileEntry[] }> {
  const snapshot = await client.getSnapshotByKey(snapshotKey);
  if (!snapshot) {
    throw new Error(`Snapshot not found: ${snapshotKey}`);
  }
  
  const fileRecords = await client.getSnapshotFilesWithContentByKey(snapshotKey);
  
  const files: FileEntry[] = [];
  for (const record of fileRecords) {
    files.push({
      path: record.path,
      content: record.content,
      sha256: record.sha256,
      language: record.language,
      sizeBytes: record.size_bytes,
      lineCount: record.line_count,
    });
  }
  
  return {
    snapshot: {
      snapshotKey: snapshot.snapshot_key,
      repoName: snapshot.repo_name,
      status: snapshot.status,
      fileCount: snapshot.file_count,
      totalBytes: snapshot.total_bytes,
      createdAtMs: snapshot.created_at_ms ?? 0,
      parentSnapshotId: snapshot.parent_snapshot_id,
      commitSha: snapshot.commit_sha,
    },
    files,
  };
}

export async function getLatestSnapshot(
  client: HelixClient,
  repoName: string
): Promise<SnapshotData | null> {
  const snapshots = await client.listSnapshotsByRepoName(repoName);
  if (snapshots.length === 0) return null;
  
  const latest = snapshots.sort((a, b) => (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0))[0];
  if (!latest) return null;
  
  return {
    snapshotKey: latest.snapshot_key,
    repoName,
    status: latest.status,
    fileCount: latest.file_count,
    totalBytes: latest.total_bytes,
    createdAtMs: latest.created_at_ms ?? 0,
    commitSha: latest.commit_sha,
    parentSnapshotId: latest.parent_snapshot_id,
  };
}
