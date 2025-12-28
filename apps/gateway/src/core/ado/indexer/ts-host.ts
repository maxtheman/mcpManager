import * as ts from "typescript";
import * as path from "node:path";
import * as fs from "node:fs";
import type { VirtualFS } from "../code/view.js";

export interface CompilerHostOptions {
  vfs: VirtualFS;
  compilerOptions: ts.CompilerOptions;
  rootDir: string;
}

export function createVFSCompilerHost(options: CompilerHostOptions): ts.CompilerHost {
  const { vfs, compilerOptions, rootDir } = options;
  
  const defaultLibPath = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
  
  function normalizePath(p: string): string {
    return p.replace(/\\/g, "/");
  }
  
  function toVFSPath(fileName: string): string {
    const normalized = normalizePath(fileName);
    if (normalized.startsWith(rootDir)) {
      return normalized.slice(rootDir.length).replace(/^\//, "");
    }
    return normalized;
  }
  
  function isLibFile(fileName: string): boolean {
    const normalized = normalizePath(fileName);
    return normalized.includes("/node_modules/typescript/lib/") ||
           normalized.startsWith(defaultLibPath);
  }
  
  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersion, onError) {
      const normalized = normalizePath(fileName);
      
      if (isLibFile(normalized)) {
        try {
          const content = fs.readFileSync(normalized, "utf-8");
          return ts.createSourceFile(fileName, content, languageVersion);
        } catch (e) {
          onError?.(`Could not read lib file: ${normalized}`);
          return undefined;
        }
      }
      
      const vfsPath = toVFSPath(normalized);
      const content = vfs.readFile(vfsPath);
      
      if (content === undefined) {
        return undefined;
      }
      
      return ts.createSourceFile(fileName, content, languageVersion);
    },
    
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    
    writeFile: () => {
      // No-op: we don't emit files
    },
    
    getCurrentDirectory: () => rootDir,
    
    getCanonicalFileName: (fileName) => 
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    
    getNewLine: () => "\n",
    
    fileExists(fileName) {
      const normalized = normalizePath(fileName);
      
      if (isLibFile(normalized)) {
        return fs.existsSync(normalized);
      }
      
      const vfsPath = toVFSPath(normalized);
      return vfs.fileExists(vfsPath);
    },
    
    readFile(fileName) {
      const normalized = normalizePath(fileName);
      
      if (isLibFile(normalized)) {
        try {
          return fs.readFileSync(normalized, "utf-8");
        } catch {
          return undefined;
        }
      }
      
      const vfsPath = toVFSPath(normalized);
      return vfs.readFile(vfsPath);
    },
    
    directoryExists(dirName) {
      const normalized = normalizePath(dirName);

      const vfsPath = toVFSPath(normalized);
      const files = vfs.listFiles();
      if (vfsPath === "" || vfsPath === ".") {
        return files.length > 0;
      }
      return files.some((f) => f.startsWith(vfsPath + "/") || f === vfsPath);
    },
    
    getDirectories(dirPath) {
      const normalized = normalizePath(dirPath);

      const vfsPath = toVFSPath(normalized);
      const files = vfs.listFiles();
      const dirs = new Set<string>();
      
      for (const file of files) {
        if (vfsPath === "" || file.startsWith(vfsPath + "/")) {
          const rest = vfsPath === "" ? file : file.slice(vfsPath.length + 1);
          const firstSlash = rest.indexOf("/");
          if (firstSlash > 0) {
            dirs.add(rest.slice(0, firstSlash));
          }
        }
      }
      
      return Array.from(dirs);
    },
    
    realpath(filePath) {
      return normalizePath(filePath);
    },
  };
  
  return host;
}

export function parseConfigFile(
  vfs: VirtualFS,
  tsconfigPath: string,
  rootDir: string
): ts.ParsedCommandLine {
  const configContent = vfs.readFile(tsconfigPath);
  
  if (!configContent) {
    return {
      options: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      fileNames: vfs.listFiles().filter(f => 
        f.endsWith(".ts") || f.endsWith(".tsx")
      ).map(f => path.join(rootDir, f)),
      errors: [],
    };
  }
  
  const { config, error } = ts.parseConfigFileTextToJson(tsconfigPath, configContent);
  
  if (error) {
    throw new Error(`Failed to parse tsconfig: ${error.messageText}`);
  }
  
  const configDir = path.dirname(path.join(rootDir, tsconfigPath));
  
  const parsed = ts.parseJsonConfigFileContent(
    config,
    {
      useCaseSensitiveFileNames: true,
      readDirectory: (dirPath, extensions, excludes, includes, depth) => {
        const files = vfs.listFiles();
        return files
          .filter(f => extensions?.some(ext => f.endsWith(ext)))
          .map(f => path.join(rootDir, f));
      },
      fileExists: (fileName) => vfs.fileExists(fileName.replace(rootDir + "/", "")),
      readFile: (fileName) => vfs.readFile(fileName.replace(rootDir + "/", "")),
    },
    configDir,
    undefined,
    tsconfigPath
  );
  
  return parsed;
}

export function createProgramFromVFS(
  vfs: VirtualFS,
  tsconfigPath: string,
  rootDir: string
): ts.Program {
  const parsedConfig = parseConfigFile(vfs, tsconfigPath, rootDir);
  
  const host = createVFSCompilerHost({
    vfs,
    compilerOptions: parsedConfig.options,
    rootDir,
  });
  
  return ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    host,
  });
}
