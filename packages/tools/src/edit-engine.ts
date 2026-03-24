import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import type { FileChange } from "./code-intelligence.js";

export type FileValidationResult = {
  ok: boolean;
  issues: string[];
  validatedFiles: string[];
};

type PatchTarget = {
  path: string;
  isNew: boolean;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isWithinRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveRootPath(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return resolved;
}

function scriptKindFromFilePath(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (lower.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts") || lower.endsWith(".d.ts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function formatParseDiagnostics(filePath: string, sourceFile: ts.SourceFile): string[] {
  const diagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
  }).parseDiagnostics ?? [];

  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      return `${filePath}:${line + 1}:${character + 1} ${message}`;
    });
}

function shouldValidateSyntax(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".d.ts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
  ].some((extension) => lower.endsWith(extension));
}

function validateSingleFile(filePath: string, content: string): string[] {
  if (!shouldValidateSyntax(filePath)) {
    return [];
  }

  if (filePath.toLowerCase().endsWith(".json")) {
    try {
      JSON.parse(content);
      return [];
    } catch (error) {
      return [`${filePath}: invalid JSON - ${error instanceof Error ? error.message : "Unknown JSON parse error"}`];
    }
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromFilePath(filePath),
  );
  return formatParseDiagnostics(filePath, sourceFile);
}

export function validateFileChanges(changes: FileChange[]): FileValidationResult {
  const issues: string[] = [];
  const validatedFiles: string[] = [];

  for (const change of changes) {
    if (typeof change.after !== "string" || !shouldValidateSyntax(change.filePath)) {
      continue;
    }

    validatedFiles.push(change.filePath);
    issues.push(...validateSingleFile(change.filePath, change.after));
  }

  return {
    ok: issues.length === 0,
    issues,
    validatedFiles,
  };
}

function parsePatchPath(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  const withoutPrefix = trimmed.replace(/^(a|b)\//, "");
  return withoutPrefix.split("\t")[0]?.trim() ?? "";
}

function parsePatchTargets(patch: string): PatchTarget[] {
  const lines = normalizeText(patch).split("\n");
  const targets: PatchTarget[] = [];
  let oldPath: string | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldPath = parsePatchPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      const newPath = parsePatchPath(line.slice(4));
      if (oldPath === null) {
        continue;
      }

      if (newPath === "/dev/null") {
        throw new Error("Patch deletion hunks are not supported by the current edit engine.");
      }

      if (oldPath !== "/dev/null" && oldPath !== newPath) {
        throw new Error("Patch rename hunks are not supported by the current edit engine.");
      }

      targets.push({
        path: newPath,
        isNew: oldPath === "/dev/null",
      });
      oldPath = null;
    }
  }

  if (targets.length === 0) {
    throw new Error("Patch is missing supported file headers.");
  }

  return [...new Map(targets.map((target) => [target.path, target])).values()];
}

async function spawnAndCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ ok: false, stdout, stderr: error.message, exitCode: -1 });
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });
  });
}

async function readExistingFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function createPatchWorkspace(root: string, targets: PatchTarget[]): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gradient-code-patch-"));

  for (const target of targets) {
    const sourcePath = resolveRootPath(root, target.path);
    const destinationPath = path.join(tempRoot, target.path);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    try {
      await fs.copyFile(sourcePath, destinationPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (!(target.isNew && nodeError.code === "ENOENT")) {
        throw error;
      }
    }
  }

  return tempRoot;
}

export async function materializePatchChanges(root: string, patch: string): Promise<{
  changes: FileChange[];
  validation: FileValidationResult;
}> {
  const resolvedRoot = path.resolve(root);
  const targets = parsePatchTargets(patch);
  const tempRoot = await createPatchWorkspace(resolvedRoot, targets);
  const patchPath = path.join(tempRoot, "__gradient-code.patch");

  try {
    await fs.writeFile(patchPath, patch, "utf8");

    const checkResult = await spawnAndCapture(
      "git",
      ["apply", "--check", "--unsafe-paths", "--whitespace=nowarn", patchPath],
      tempRoot,
    );

    if (!checkResult.ok) {
      throw new Error(checkResult.stderr.trim() || checkResult.stdout.trim() || "git apply --check failed");
    }

    const applyResult = await spawnAndCapture(
      "git",
      ["apply", "--unsafe-paths", "--whitespace=nowarn", patchPath],
      tempRoot,
    );

    if (!applyResult.ok) {
      throw new Error(applyResult.stderr.trim() || applyResult.stdout.trim() || "git apply failed");
    }

    const changes: FileChange[] = [];

    for (const target of targets) {
      const workspacePath = resolveRootPath(resolvedRoot, target.path);
      const tempPath = path.join(tempRoot, target.path);
      const before = await readExistingFile(workspacePath);
      const after = await readExistingFile(tempPath);

      if (normalizeText(before) === normalizeText(after)) {
        continue;
      }

      changes.push({
        filePath: workspacePath,
        before,
        after,
      });
    }

    return {
      changes,
      validation: validateFileChanges(changes),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
