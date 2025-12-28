import type { FileEntry } from "./snapshot.js";
import type { FileEdit } from "./proposal.js";

export interface VirtualFS {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
  listFiles(): string[];
  getCurrentDirectory(): string;
}

export class SnapshotView implements VirtualFS {
  private files: Map<string, FileEntry>;
  private cwd: string;
  
  constructor(files: FileEntry[], cwd: string = "/") {
    this.files = new Map(files.map((f) => [f.path, f]));
    this.cwd = cwd;
  }
  
  readFile(path: string): string | undefined {
    const normalized = this.normalizePath(path);
    return this.files.get(normalized)?.content;
  }
  
  fileExists(path: string): boolean {
    const normalized = this.normalizePath(path);
    return this.files.has(normalized);
  }
  
  listFiles(): string[] {
    return Array.from(this.files.keys());
  }
  
  getCurrentDirectory(): string {
    return this.cwd;
  }
  
  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\//, "");
  }
}

export class ProposalView implements VirtualFS {
  private baseFiles: Map<string, FileEntry>;
  private edits: Map<string, FileEdit>;
  private deletedPaths: Set<string>;
  private renamedPaths: Map<string, string>;
  private cwd: string;
  
  constructor(baseFiles: FileEntry[], edits: FileEdit[], cwd: string = "/") {
    this.baseFiles = new Map(baseFiles.map((f) => [f.path, f]));
    this.edits = new Map();
    this.deletedPaths = new Set();
    this.renamedPaths = new Map();
    this.cwd = cwd;
    
    for (const edit of edits) {
      const path = this.normalizePath(edit.path);
      
      switch (edit.kind) {
        case "add":
        case "modify":
          this.edits.set(path, edit);
          break;
        case "delete":
          this.deletedPaths.add(path);
          break;
        case "rename":
          if (edit.oldPath) {
            const oldPath = this.normalizePath(edit.oldPath);
            this.deletedPaths.add(oldPath);
            this.renamedPaths.set(oldPath, path);
            this.edits.set(path, edit);
          }
          break;
      }
    }
  }
  
  readFile(path: string): string | undefined {
    const normalized = this.normalizePath(path);
    
    if (this.deletedPaths.has(normalized)) {
      return undefined;
    }
    
    const edit = this.edits.get(normalized);
    if (edit?.content !== undefined) {
      return edit.content;
    }
    
    return this.baseFiles.get(normalized)?.content;
  }
  
  fileExists(path: string): boolean {
    const normalized = this.normalizePath(path);
    
    if (this.deletedPaths.has(normalized)) {
      return false;
    }
    
    if (this.edits.has(normalized)) {
      return true;
    }
    
    return this.baseFiles.has(normalized);
  }
  
  listFiles(): string[] {
    const allPaths = new Set<string>();
    
    for (const path of this.baseFiles.keys()) {
      if (!this.deletedPaths.has(path)) {
        allPaths.add(path);
      }
    }
    
    for (const path of this.edits.keys()) {
      allPaths.add(path);
    }
    
    return Array.from(allPaths);
  }
  
  getCurrentDirectory(): string {
    return this.cwd;
  }
  
  getModifiedPaths(): string[] {
    return Array.from(this.edits.keys());
  }
  
  getDeletedPaths(): string[] {
    return Array.from(this.deletedPaths);
  }
  
  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\//, "");
  }
}

export function createViewFromSnapshot(files: FileEntry[], cwd?: string): VirtualFS {
  return new SnapshotView(files, cwd);
}

export function createViewFromProposal(
  baseFiles: FileEntry[],
  edits: FileEdit[],
  cwd?: string
): ProposalView {
  return new ProposalView(baseFiles, edits, cwd);
}
