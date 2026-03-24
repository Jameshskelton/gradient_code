import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCodeWorkspace, findReferences, findSymbols, listExports, listImports, performAstEdit, } from "./code-intelligence.js";
import { materializePatchChanges, validateFileChanges } from "./edit-engine.js";
const commandSessions = new Map();
function ok(toolName, content, metadata) {
    return { ok: true, toolName, content, metadata };
}
function fail(toolName, code, message, metadata) {
    return { ok: false, toolName, error: { code, message }, metadata };
}
function workspaceRoot(cwd) {
    return path.resolve(cwd);
}
function resolveWorkspacePath(cwd, target) {
    const root = workspaceRoot(cwd);
    const resolved = path.resolve(root, target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Path escapes workspace: ${target}`);
    }
    return resolved;
}
function relativeToWorkspace(cwd, target) {
    return path.relative(workspaceRoot(cwd), target) || ".";
}
function normalizeText(value) {
    return value.replace(/\r\n/g, "\n");
}
function splitLines(value) {
    return normalizeText(value).split("\n");
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
async function findFiles(root) {
    const results = [];
    async function walk(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".gradient-code") {
                continue;
            }
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (entry.isFile()) {
                results.push(fullPath);
            }
        }
    }
    await walk(root);
    return results.sort((left, right) => left.localeCompare(right));
}
async function findWorkspaceEntries(root, options) {
    const results = [];
    const maxDepth = options?.maxDepth ?? 4;
    const includeFiles = options?.includeFiles ?? true;
    const includeDirectories = options?.includeDirectories ?? true;
    async function walk(currentPath, depth) {
        if (depth > maxDepth) {
            return;
        }
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".gradient-code") {
                continue;
            }
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                if (includeDirectories) {
                    results.push({ path: fullPath, type: "directory" });
                }
                await walk(fullPath, depth + 1);
                continue;
            }
            if (entry.isFile() && includeFiles) {
                results.push({ path: fullPath, type: "file" });
            }
        }
    }
    await walk(root, 0);
    return results.sort((left, right) => left.path.localeCompare(right.path));
}
function isProbablyTextFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return [
        ".c",
        ".cc",
        ".cpp",
        ".css",
        ".go",
        ".html",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".mjs",
        ".md",
        ".py",
        ".rb",
        ".rs",
        ".sh",
        ".sql",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".yaml",
        ".yml",
    ].includes(extension) || extension === "";
}
async function searchTextFallback(cwd, query) {
    const files = await findFiles(workspaceRoot(cwd));
    const matches = [];
    for (const filePath of files) {
        if (!isProbablyTextFile(filePath)) {
            continue;
        }
        let content = "";
        try {
            content = await fs.readFile(filePath, "utf8");
        }
        catch {
            continue;
        }
        const lines = normalizeText(content).split("\n");
        lines.forEach((line, index) => {
            if (line.includes(query)) {
                matches.push(`${relativeToWorkspace(cwd, filePath)}:${index + 1}:${line}`);
            }
        });
    }
    return ok("search_text", matches.length > 0 ? matches.join("\n") : "No matches found.", {
        engine: "node-fallback",
        matchCount: matches.length,
    });
}
async function ensureCommandsDir(cwd) {
    const directory = path.join(cwd, ".gradient-code", "commands");
    await fs.mkdir(directory, { recursive: true });
    return directory;
}
function decodeHtmlEntities(value) {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/gi, "/")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)));
}
function stripHtml(value) {
    return decodeHtmlEntities(value
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")).trim();
}
async function fetchTextFromUrl(url, timeoutMs = 15_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "user-agent": "Gradient-Code/0.1 (+https://github.com/gradient-code)",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return await response.text();
    }
    finally {
        clearTimeout(timer);
    }
}
function extractSearchResultsFromHtml(html, limit) {
    const results = [];
    const seen = new Set();
    const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(anchorPattern)) {
        const href = decodeHtmlEntities(match[1] ?? "").trim();
        const title = stripHtml(match[2] ?? "");
        if (!href || !title) {
            continue;
        }
        let resolvedUrl = href;
        if (resolvedUrl.startsWith("//")) {
            resolvedUrl = `https:${resolvedUrl}`;
        }
        if (!/^https?:\/\//i.test(resolvedUrl)) {
            continue;
        }
        if (seen.has(resolvedUrl)) {
            continue;
        }
        seen.add(resolvedUrl);
        results.push({ title, url: resolvedUrl });
        if (results.length >= limit) {
            break;
        }
    }
    return results;
}
function isBlockedNetworkTarget(urlText) {
    let url;
    try {
        url = new URL(urlText);
    }
    catch {
        return "URL is invalid";
    }
    const hostname = url.hostname.toLowerCase();
    if (!hostname) {
        return "URL hostname is missing";
    }
    if (url.username || url.password) {
        return "Embedded URL credentials are not allowed";
    }
    if (hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname === "host.docker.internal") {
        return "Local and private network hosts are blocked";
    }
    if (hostname === "::1" || hostname === "[::1]") {
        return "Local and private network hosts are blocked";
    }
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const octets = ipv4Match.slice(1).map((value) => Number.parseInt(value, 10));
        if (octets.some((value) => value < 0 || value > 255)) {
            return "URL IPv4 address is invalid";
        }
        const [first, second] = octets;
        if (first === 10 ||
            first === 127 ||
            first === 0 ||
            (first === 169 && second === 254) ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168)) {
            return "Local and private network hosts are blocked";
        }
    }
    if (hostname.includes(":")) {
        const normalized = hostname.replace(/^\[|\]$/g, "");
        if (normalized === "::1" ||
            normalized.startsWith("fc") ||
            normalized.startsWith("fd") ||
            normalized.startsWith("fe80:")) {
            return "Local and private network hosts are blocked";
        }
    }
    return null;
}
function sessionMetadataPath(logPath) {
    return logPath.replace(/\.log$/, ".json");
}
async function persistCommandSession(session) {
    await fs.writeFile(sessionMetadataPath(session.logPath), `${JSON.stringify({
        id: session.id,
        command: session.command,
        cwd: session.cwd,
        exitCode: session.exitCode,
        logPath: session.logPath,
    }, null, 2)}\n`, "utf8");
}
async function appendCommandLog(session, chunk, stream) {
    await fs.appendFile(session.logPath, `[${stream}] ${chunk}`, "utf8");
}
async function createCommandSession(cwd, command, sessionId) {
    const id = sessionId || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const commandsDir = await ensureCommandsDir(cwd);
    const logPath = path.join(commandsDir, `${id}.log`);
    const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const session = {
        id,
        command,
        cwd,
        process: child,
        stdout: "",
        stderr: "",
        lastReadStdout: 0,
        lastReadStderr: 0,
        exitCode: null,
        logPath,
    };
    child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        session.stdout += text;
        void appendCommandLog(session, text, "stdout");
    });
    child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        session.stderr += text;
        void appendCommandLog(session, text, "stderr");
    });
    child.on("close", (code) => {
        session.exitCode = code ?? 0;
        void persistCommandSession(session);
    });
    child.on("error", (error) => {
        session.stderr += error.message;
        void appendCommandLog(session, error.message, "stderr");
        session.exitCode = -1;
        void persistCommandSession(session);
    });
    commandSessions.set(id, session);
    await persistCommandSession(session);
    return session;
}
function getCommandSession(sessionId) {
    return commandSessions.get(sessionId);
}
async function spawnAndCapture(command, args, cwd) {
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
function renderUnifiedDiff(filePath, before, after) {
    const beforeLines = splitLines(before);
    const afterLines = splitLines(after);
    const maxLength = Math.max(beforeLines.length, afterLines.length);
    const diffLines = [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ];
    for (let index = 0; index < maxLength; index += 1) {
        const beforeLine = beforeLines[index];
        const afterLine = afterLines[index];
        if (beforeLine === afterLine) {
            if (beforeLine !== undefined) {
                diffLines.push(` ${beforeLine}`);
            }
            continue;
        }
        if (beforeLine !== undefined) {
            diffLines.push(`-${beforeLine}`);
        }
        if (afterLine !== undefined) {
            diffLines.push(`+${afterLine}`);
        }
    }
    return diffLines.join("\n");
}
function renderCombinedDiff(cwd, changes) {
    return changes
        .map((change) => renderUnifiedDiff(relativeToWorkspace(cwd, change.filePath), change.before, change.after))
        .join("\n\n");
}
async function readExistingFile(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    }
    catch (error) {
        const nodeError = error;
        if (nodeError.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}
function truncateContent(value, maxChars) {
    if (value.length <= maxChars) {
        return { text: value, truncated: false };
    }
    return {
        text: `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} characters]`,
        truncated: true,
    };
}
async function approveEdit(context, toolName, summary, diff) {
    if (!context.previewEdits) {
        return context.approve(toolName, summary);
    }
    return context.approve(toolName, `${summary}\n\n${diff}`);
}
async function writeTextFile(context, toolName, relativePath, content, summaryPrefix) {
    try {
        const filePath = resolveWorkspacePath(context.cwd, relativePath);
        const existing = await readExistingFile(filePath);
        return writeTextFiles(context, toolName, [{ filePath, before: existing, after: content }], summaryPrefix);
    }
    catch (error) {
        return fail(toolName, "WRITE_FAILED", error instanceof Error ? error.message : "Unknown write error");
    }
}
async function writeTextFiles(context, toolName, changes, summary) {
    const normalizedChanges = changes
        .map((change) => ({
        filePath: resolveWorkspacePath(context.cwd, relativeToWorkspace(context.cwd, change.filePath)),
        before: change.before,
        after: change.after,
    }))
        .filter((change) => normalizeText(change.before) !== normalizeText(change.after));
    if (normalizedChanges.length === 0) {
        return ok(toolName, "No changes were necessary.", { changed: false, changedFiles: 0 });
    }
    const validation = validateFileChanges(normalizedChanges);
    if (!validation.ok) {
        return fail(toolName, "VALIDATION_FAILED", `Edit validation failed:\n${validation.issues.join("\n")}`, {
            paths: normalizedChanges.map((change) => change.filePath),
            validationIssues: validation.issues,
            validatedFiles: validation.validatedFiles,
        });
    }
    const diff = renderCombinedDiff(context.cwd, normalizedChanges);
    const approved = await approveEdit(context, toolName, normalizedChanges.length === 1
        ? `${summary} ${relativeToWorkspace(context.cwd, normalizedChanges[0].filePath)}`
        : `${summary} ${normalizedChanges.length} files`, diff);
    if (!approved) {
        return fail(toolName, "PERMISSION_DENIED", "User declined AST-aware edit", {
            paths: normalizedChanges.map((change) => change.filePath),
            diff,
        });
    }
    const rollbackState = await Promise.all(normalizedChanges.map(async (change) => ({
        filePath: change.filePath,
        before: change.before,
        existed: await pathExists(change.filePath),
    })));
    for (const change of normalizedChanges) {
        try {
            await fs.mkdir(path.dirname(change.filePath), { recursive: true });
            await fs.writeFile(change.filePath, change.after, "utf8");
        }
        catch (error) {
            await Promise.all(rollbackState.map(async (entry) => {
                if (!entry.existed) {
                    await fs.rm(entry.filePath, { force: true });
                    return;
                }
                await fs.mkdir(path.dirname(entry.filePath), { recursive: true });
                await fs.writeFile(entry.filePath, entry.before, "utf8");
            }));
            return fail(toolName, "WRITE_FAILED", error instanceof Error ? error.message : "Unknown write error", {
                paths: normalizedChanges.map((change) => change.filePath),
                diff,
                rolledBack: true,
            });
        }
    }
    const onDiskChanges = [];
    for (const change of normalizedChanges) {
        const actual = await readExistingFile(change.filePath);
        onDiskChanges.push({
            filePath: change.filePath,
            before: change.before,
            after: actual,
        });
    }
    const postWriteValidation = validateFileChanges(onDiskChanges);
    const contentMismatch = onDiskChanges.find((change) => normalizeText(change.after) !== normalizeText(normalizedChanges.find((entry) => entry.filePath === change.filePath)?.after ?? ""));
    if (!postWriteValidation.ok || contentMismatch) {
        await Promise.all(rollbackState.map(async (entry) => {
            if (!entry.existed) {
                await fs.rm(entry.filePath, { force: true });
                return;
            }
            await fs.mkdir(path.dirname(entry.filePath), { recursive: true });
            await fs.writeFile(entry.filePath, entry.before, "utf8");
        }));
        return fail(toolName, "POST_WRITE_VALIDATION_FAILED", postWriteValidation.ok
            ? `Wrote files but verification failed for ${relativeToWorkspace(context.cwd, contentMismatch?.filePath ?? context.cwd)}`
            : `Wrote files but validation failed:\n${postWriteValidation.issues.join("\n")}`, {
            paths: normalizedChanges.map((change) => change.filePath),
            diff,
            rolledBack: true,
            validationIssues: postWriteValidation.issues,
        });
    }
    return ok(toolName, normalizedChanges.length === 1
        ? `Updated ${relativeToWorkspace(context.cwd, normalizedChanges[0].filePath)}`
        : `Updated ${normalizedChanges.length} files`, {
        path: normalizedChanges.length === 1 ? normalizedChanges[0].filePath : undefined,
        paths: normalizedChanges.map((change) => change.filePath),
        changed: true,
        changedFiles: normalizedChanges.length,
        diff,
        validatedFiles: validation.validatedFiles,
    });
}
function formatSymbolMatch(cwd, match) {
    const exported = match.exported ? " exported" : "";
    const container = match.containerName ? ` in ${match.containerName}` : "";
    return `${relativeToWorkspace(cwd, match.filePath)}:${match.line}:${match.column} ${match.kind}${exported} ${match.name}${container}\n${match.preview}`;
}
function formatReference(cwd, reference) {
    const kind = reference.isDefinition ? "definition" : "reference";
    return `${relativeToWorkspace(cwd, reference.filePath)}:${reference.line}:${reference.column} ${kind}\n${reference.preview}`;
}
function formatExport(cwd, filePath, item) {
    const typeSuffix = item.isTypeOnly ? " type" : "";
    const defaultSuffix = item.isDefault ? " default" : "";
    const sourceSuffix = item.moduleSpecifier ? ` from ${item.moduleSpecifier}` : "";
    return `${relativeToWorkspace(cwd, filePath)}:${item.line}:${item.column} ${item.kind}${typeSuffix}${defaultSuffix} ${item.name}${sourceSuffix}\n${item.preview}`;
}
function formatImport(cwd, filePath, item) {
    const binding = item.localName ? ` ${item.localName}` : "";
    const imported = item.imported ? ` <= ${item.imported}` : "";
    const typeSuffix = item.isTypeOnly ? " type" : "";
    return `${relativeToWorkspace(cwd, filePath)}:${item.line}:${item.column} ${item.kind}${typeSuffix}${binding}${imported} from ${item.moduleSpecifier}\n${item.preview}`;
}
const TEST_FILE_PATTERNS = [
    /(^|\/)__tests__(\/|$)/i,
    /(^|\/)(test|tests|spec|specs)(\/|$)/i,
    /\.(test|spec)\.[^.]+$/i,
];
const SOURCE_CODE_EXTENSIONS = new Set([
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".mjs",
    ".mts",
    ".py",
    ".rb",
    ".rs",
    ".swift",
    ".ts",
    ".tsx",
]);
function parseGitRenamePath(rawPath) {
    const trimmed = rawPath.trim();
    const braceMatch = trimmed.match(/^(.*)\{(.+?) => (.+?)\}(.*)$/);
    if (braceMatch) {
        const prefix = braceMatch[1] ?? "";
        const before = braceMatch[2] ?? "";
        const after = braceMatch[3] ?? "";
        const suffix = braceMatch[4] ?? "";
        return {
            previousPath: `${prefix}${before}${suffix}`,
            path: `${prefix}${after}${suffix}`,
        };
    }
    const arrowIndex = trimmed.indexOf(" -> ");
    if (arrowIndex !== -1) {
        return {
            previousPath: trimmed.slice(0, arrowIndex).trim(),
            path: trimmed.slice(arrowIndex + 4).trim(),
        };
    }
    return { path: trimmed };
}
function mapGitStatusCode(code) {
    switch (code) {
        case "M":
            return "modified";
        case "A":
            return "added";
        case "D":
            return "deleted";
        case "R":
            return "renamed";
        case "C":
            return "copied";
        case "U":
            return "conflicted";
        case "?":
            return "untracked";
        case "!":
            return "ignored";
        default:
            return "unchanged";
    }
}
function describeGitStatus(stagedCode, unstagedCode) {
    if (stagedCode === "?" && unstagedCode === "?") {
        return "untracked";
    }
    const parts = new Set();
    if (stagedCode !== " " && stagedCode !== "") {
        parts.add(mapGitStatusCode(stagedCode));
    }
    if (unstagedCode !== " " && unstagedCode !== "") {
        parts.add(mapGitStatusCode(unstagedCode));
    }
    return [...parts].filter((part) => part !== "unchanged").join(" / ") || "modified";
}
function parseGitStatusOutput(output) {
    const files = [];
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line) {
            continue;
        }
        const stagedCode = line[0] ?? " ";
        const unstagedCode = line[1] ?? " ";
        const parsedPath = parseGitRenamePath(line.slice(3));
        files.push({
            path: parsedPath.path,
            previousPath: parsedPath.previousPath,
            stagedCode,
            unstagedCode,
            statusLabel: describeGitStatus(stagedCode, unstagedCode),
            untracked: stagedCode === "?" && unstagedCode === "?",
        });
    }
    return files;
}
function mergeNumstatEntry(map, rawPath, additionsRaw, deletionsRaw) {
    const parsedPath = parseGitRenamePath(rawPath);
    const existing = map.get(parsedPath.path) ?? {};
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    const additions = binary ? undefined : Number.parseInt(additionsRaw, 10);
    const deletions = binary ? undefined : Number.parseInt(deletionsRaw, 10);
    const safeAdditions = typeof additions === "number" && Number.isFinite(additions) ? additions : 0;
    const safeDeletions = typeof deletions === "number" && Number.isFinite(deletions) ? deletions : 0;
    map.set(parsedPath.path, {
        additions: (existing.additions ?? 0) + safeAdditions,
        deletions: (existing.deletions ?? 0) + safeDeletions,
        binary: existing.binary === true || binary,
        previousPath: parsedPath.previousPath ?? existing.previousPath,
    });
}
function parseGitNumstat(output) {
    const map = new Map();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const parts = rawLine.split("\t");
        if (parts.length < 3) {
            continue;
        }
        mergeNumstatEntry(map, parts.slice(2).join("\t"), parts[0], parts[1]);
    }
    return map;
}
async function resolveGitRoot(cwd) {
    const result = await spawnAndCapture("git", ["rev-parse", "--show-toplevel"], cwd);
    if (!result.ok || result.exitCode !== 0) {
        return null;
    }
    const root = result.stdout.trim();
    return root ? path.resolve(root) : null;
}
async function collectGitChangedFiles(cwd) {
    const gitRoot = await resolveGitRoot(cwd);
    if (!gitRoot) {
        return null;
    }
    const statusResult = await spawnAndCapture("git", ["status", "--short", "--untracked-files=all"], cwd);
    if (!statusResult.ok && statusResult.exitCode !== 0) {
        return null;
    }
    const unstagedNumstatResult = await spawnAndCapture("git", ["diff", "--numstat", "--find-renames"], cwd);
    const stagedNumstatResult = await spawnAndCapture("git", ["diff", "--cached", "--numstat", "--find-renames"], cwd);
    const numstatMap = parseGitNumstat(`${unstagedNumstatResult.stdout}\n${stagedNumstatResult.stdout}`);
    const statusEntries = parseGitStatusOutput(statusResult.stdout);
    const filesByPath = new Map();
    for (const entry of statusEntries) {
        const numstat = numstatMap.get(entry.path);
        filesByPath.set(entry.path, {
            ...entry,
            previousPath: entry.previousPath ?? numstat?.previousPath,
            additions: numstat?.binary ? undefined : numstat?.additions,
            deletions: numstat?.binary ? undefined : numstat?.deletions,
            binary: numstat?.binary === true,
        });
    }
    for (const [filePath, numstat] of numstatMap.entries()) {
        if (filesByPath.has(filePath)) {
            continue;
        }
        filesByPath.set(filePath, {
            path: filePath,
            previousPath: numstat.previousPath,
            stagedCode: "M",
            unstagedCode: " ",
            statusLabel: numstat.previousPath ? "renamed" : "modified",
            additions: numstat.binary ? undefined : numstat.additions,
            deletions: numstat.binary ? undefined : numstat.deletions,
            binary: numstat.binary === true,
        });
    }
    return {
        gitRoot,
        files: [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
}
function formatChangedFileLine(file) {
    const pathLabel = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
    const statsLabel = file.binary
        ? "binary"
        : typeof file.additions === "number" || typeof file.deletions === "number"
            ? `+${String(file.additions ?? 0)} -${String(file.deletions ?? 0)}`
            : "no line stats";
    return `${file.statusLabel}: ${pathLabel} (${statsLabel})`;
}
function parseDiffHunkHeaders(diffText) {
    const headers = new Set();
    for (const line of diffText.split(/\r?\n/)) {
        const match = line.match(/^@@ [^@]+ @@\s?(.*)$/);
        const label = match?.[1]?.trim();
        if (label) {
            headers.add(label);
        }
    }
    return [...headers];
}
function extractChangedLinePreview(diffText, limit = 8) {
    const lines = [];
    for (const line of diffText.split(/\r?\n/)) {
        if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
            lines.push(line);
        }
        if (lines.length >= limit) {
            break;
        }
    }
    return lines;
}
function isTestFilePath(relativePath) {
    return TEST_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}
function stripKnownExtensions(relativePath) {
    const extension = path.extname(relativePath);
    return extension ? relativePath.slice(0, -extension.length) : relativePath;
}
function uniqueStrings(values) {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
}
function likelyTestPathCandidates(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (isTestFilePath(normalized)) {
        return [normalized];
    }
    const extension = path.extname(normalized);
    const barePath = stripKnownExtensions(normalized);
    const directory = path.posix.dirname(normalized);
    const fileName = path.posix.basename(barePath);
    const parentDirectory = directory === "." ? "" : directory;
    const rootName = fileName === "index" && parentDirectory ? path.posix.basename(parentDirectory) : fileName;
    const extensions = uniqueStrings([extension, ".ts", ".tsx", ".js", ".jsx", ".mts", ".py", ".go"]);
    const candidates = [];
    for (const ext of extensions) {
        candidates.push(`${barePath}.test${ext}`);
        candidates.push(`${barePath}.spec${ext}`);
        if (parentDirectory) {
            candidates.push(`${parentDirectory}/__tests__/${fileName}.test${ext}`);
            candidates.push(`${parentDirectory}/__tests__/${fileName}.spec${ext}`);
            candidates.push(`${parentDirectory}/tests/${fileName}.test${ext}`);
            candidates.push(`${parentDirectory}/tests/${fileName}.spec${ext}`);
            candidates.push(`${parentDirectory}/test/${fileName}.test${ext}`);
            candidates.push(`${parentDirectory}/test/${fileName}.spec${ext}`);
            candidates.push(`${parentDirectory}/spec/${fileName}.spec${ext}`);
            candidates.push(`${parentDirectory}/specs/${fileName}.spec${ext}`);
            if (rootName !== fileName) {
                candidates.push(`${parentDirectory}/__tests__/${rootName}.test${ext}`);
                candidates.push(`${parentDirectory}/__tests__/${rootName}.spec${ext}`);
            }
        }
        candidates.push(`tests/${fileName}.test${ext}`);
        candidates.push(`tests/${fileName}.spec${ext}`);
        candidates.push(`test/${fileName}.test${ext}`);
        candidates.push(`test/${fileName}.spec${ext}`);
        candidates.push(`spec/${fileName}.spec${ext}`);
    }
    return uniqueStrings(candidates);
}
function filePathLikelyNeedsTests(relativePath) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!SOURCE_CODE_EXTENSIONS.has(extension)) {
        return false;
    }
    if (isTestFilePath(relativePath)) {
        return false;
    }
    return !/(^|\/)(docs?|examples?|fixtures?|migrations?|dist|build)\//i.test(relativePath);
}
async function detectLikelyTestCommands(cwd) {
    const commands = [];
    const packageJsonPath = path.join(cwd, "package.json");
    if (await pathExists(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
            const scripts = packageJson.scripts ?? {};
            const hasPnpmLock = await pathExists(path.join(cwd, "pnpm-lock.yaml"));
            const hasYarnLock = await pathExists(path.join(cwd, "yarn.lock"));
            const packageManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : "npm";
            if (scripts.test) {
                commands.push(packageManager === "npm" ? "npm test" : `${packageManager} test`);
            }
            if (scripts["test:unit"]) {
                commands.push(packageManager === "npm" ? "npm run test:unit" : `${packageManager} test:unit`);
            }
            if (scripts["test:ci"]) {
                commands.push(packageManager === "npm" ? "npm run test:ci" : `${packageManager} test:ci`);
            }
            const dependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
            if (dependencies.vitest && !commands.some((command) => command.includes("vitest"))) {
                commands.push(packageManager === "npm" ? "npx vitest run" : `${packageManager} vitest run`);
            }
            if (dependencies.jest && !commands.some((command) => command.includes("jest"))) {
                commands.push(packageManager === "npm" ? "npx jest" : `${packageManager} jest`);
            }
        }
        catch {
            // Ignore malformed package.json files.
        }
    }
    if ((await pathExists(path.join(cwd, "pytest.ini"))) ||
        (await pathExists(path.join(cwd, "tox.ini"))) ||
        (await pathExists(path.join(cwd, "conftest.py")))) {
        commands.push("pytest");
    }
    if (await pathExists(path.join(cwd, "go.mod"))) {
        commands.push("go test ./...");
    }
    if (await pathExists(path.join(cwd, "Cargo.toml"))) {
        commands.push("cargo test");
    }
    return uniqueStrings(commands).slice(0, 6);
}
export const readFileTool = {
    name: "read_file",
    description: "Read a UTF-8 text file inside the current workspace.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
            path: {
                type: "string",
                description: "Path to the file relative to the workspace root.",
            },
        },
    },
    async execute(input, context) {
        const relativePath = String(input.path ?? "");
        try {
            const filePath = resolveWorkspacePath(context.cwd, relativePath);
            const content = await fs.readFile(filePath, "utf8");
            return ok(this.name, content, { path: filePath });
        }
        catch (error) {
            return fail(this.name, "READ_FAILED", error instanceof Error ? error.message : "Unknown read error");
        }
    },
};
export const readManyFilesTool = {
    name: "read_many_files",
    description: "Read several UTF-8 text files in one tool call for faster repo inspection.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["paths"],
        properties: {
            paths: {
                type: "array",
                items: {
                    type: "string",
                },
                description: "List of file paths relative to the workspace root.",
            },
            max_chars_per_file: {
                type: "number",
                description: "Optional maximum characters to return per file.",
            },
        },
    },
    async execute(input, context) {
        const rawPaths = Array.isArray(input.paths) ? input.paths : [];
        const paths = rawPaths.filter((value) => typeof value === "string" && value.trim().length > 0);
        const maxChars = typeof input.max_chars_per_file === "number" ? Math.max(250, Math.min(input.max_chars_per_file, 20_000)) : 6_000;
        if (paths.length === 0) {
            return fail(this.name, "INVALID_INPUT", "Missing paths array");
        }
        const chunks = [];
        let truncatedCount = 0;
        for (const relativePath of paths.slice(0, 20)) {
            try {
                const filePath = resolveWorkspacePath(context.cwd, relativePath);
                const content = await fs.readFile(filePath, "utf8");
                const truncated = truncateContent(content, maxChars);
                if (truncated.truncated) {
                    truncatedCount += 1;
                }
                chunks.push(`=== ${relativeToWorkspace(context.cwd, filePath)} ===\n${truncated.text}`);
            }
            catch (error) {
                chunks.push(`=== ${relativePath} ===\n[read failed] ${error instanceof Error ? error.message : "Unknown read error"}`);
            }
        }
        return ok(this.name, chunks.join("\n\n"), {
            count: Math.min(paths.length, 20),
            requested: paths.length,
            truncatedCount,
        });
    },
};
export const getCwdTool = {
    name: "get_cwd",
    description: "Return the current workspace root for this session.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {},
    },
    async execute(_input, context) {
        return ok(this.name, context.cwd, { cwd: context.cwd });
    },
};
export const inspectPathTool = {
    name: "inspect_path",
    description: "Inspect a file or directory path and return type and basic metadata.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
            path: {
                type: "string",
                description: "Path relative to the workspace root.",
            },
        },
    },
    async execute(input, context) {
        const relativePath = String(input.path ?? "");
        if (!relativePath) {
            return fail(this.name, "INVALID_INPUT", "Missing path");
        }
        try {
            const targetPath = resolveWorkspacePath(context.cwd, relativePath);
            const stats = await fs.stat(targetPath);
            const type = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
            return ok(this.name, [
                `path: ${relativeToWorkspace(context.cwd, targetPath)}`,
                `type: ${type}`,
                `size: ${String(stats.size)}`,
                `modified: ${stats.mtime.toISOString()}`,
            ].join("\n"), {
                path: targetPath,
                type,
                size: stats.size,
                modifiedAt: stats.mtime.toISOString(),
            });
        }
        catch (error) {
            return fail(this.name, "INSPECT_FAILED", error instanceof Error ? error.message : "Unknown inspect error");
        }
    },
};
export const listFilesTool = {
    name: "list_files",
    description: "List files under the current workspace. Can limit results and focus on a subdirectory.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Optional relative subdirectory to list from.",
            },
            limit: {
                type: "string",
                description: "Optional maximum number of files to return as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const relativePath = String(input.path ?? ".");
        const requestedLimit = Number.parseInt(String(input.limit ?? "60"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 300)) : 60;
        try {
            const targetPath = resolveWorkspacePath(context.cwd, relativePath);
            const stats = await fs.stat(targetPath);
            if (stats.isFile()) {
                return ok(this.name, relativeToWorkspace(context.cwd, targetPath), {
                    count: 1,
                    root: targetPath,
                });
            }
            const files = await findFiles(targetPath);
            const relativeFiles = files.slice(0, limit).map((filePath) => relativeToWorkspace(context.cwd, filePath));
            const truncated = files.length > limit;
            return ok(this.name, relativeFiles.join("\n") || "No files found.", {
                count: files.length,
                returned: relativeFiles.length,
                truncated,
                root: targetPath,
            });
        }
        catch (error) {
            return fail(this.name, "LIST_FAILED", error instanceof Error ? error.message : "Unknown list error");
        }
    },
};
export const listTreeTool = {
    name: "list_tree",
    description: "List files and directories in a tree-like view with optional depth and limits.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Optional relative root path to inspect from.",
            },
            max_depth: {
                type: "number",
                description: "Optional maximum directory depth to recurse.",
            },
            limit: {
                type: "number",
                description: "Optional maximum number of entries to return.",
            },
        },
    },
    async execute(input, context) {
        const relativePath = String(input.path ?? ".");
        const maxDepth = typeof input.max_depth === "number" ? Math.max(0, Math.min(input.max_depth, 8)) : 3;
        const limit = typeof input.limit === "number" ? Math.max(1, Math.min(input.limit, 400)) : 120;
        try {
            const targetPath = resolveWorkspacePath(context.cwd, relativePath);
            const entries = await findWorkspaceEntries(targetPath, {
                maxDepth,
                includeFiles: true,
                includeDirectories: true,
            });
            const rendered = entries.slice(0, limit).map((entry) => {
                const relativeEntry = relativeToWorkspace(context.cwd, entry.path);
                const localRelative = path.relative(targetPath, entry.path);
                const depth = localRelative === "" ? 0 : localRelative.split(path.sep).length - 1;
                const indent = "  ".repeat(Math.max(0, depth));
                return `${indent}${entry.type === "directory" ? "[dir]" : "[file]"} ${relativeEntry}`;
            });
            return ok(this.name, rendered.join("\n") || "No entries found.", {
                root: targetPath,
                count: entries.length,
                returned: rendered.length,
                truncated: entries.length > limit,
                maxDepth,
            });
        }
        catch (error) {
            return fail(this.name, "TREE_FAILED", error instanceof Error ? error.message : "Unknown tree error");
        }
    },
};
export const findSymbolTool = {
    name: "find_symbol",
    description: "Find functions, classes, interfaces, types, variables, methods, and other declarations in JS/TS files using AST parsing.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
            query: {
                type: "string",
                description: "Symbol name or partial symbol name to search for.",
            },
            path: {
                type: "string",
                description: "Optional file or directory path relative to the workspace root to narrow the search.",
            },
            exact: {
                type: "string",
                enum: ["true", "false"],
                description: "Whether to require an exact symbol-name match.",
            },
            kind: {
                type: "string",
                description: "Optional symbol kind filter such as function, class, interface, type, enum, variable, method, property, or namespace.",
            },
            limit: {
                type: "string",
                description: "Optional maximum number of matches to return as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const query = String(input.query ?? "").trim();
        const pathFilter = String(input.path ?? "").trim();
        const exact = String(input.exact ?? "false") === "true";
        const kind = String(input.kind ?? "").trim() || undefined;
        const requestedLimit = Number.parseInt(String(input.limit ?? "20"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
        if (!query) {
            return fail(this.name, "INVALID_INPUT", "Missing symbol query");
        }
        let scopePath;
        try {
            scopePath = pathFilter ? resolveWorkspacePath(context.cwd, pathFilter) : undefined;
        }
        catch (error) {
            return fail(this.name, "INVALID_PATH", error instanceof Error ? error.message : "Invalid path");
        }
        const workspace = await createCodeWorkspace(context.cwd);
        try {
            if (workspace.fileNames.length === 0) {
                return fail(this.name, "NO_SOURCE_FILES", "No supported JS/TS source files were found in the workspace");
            }
            const matches = findSymbols(workspace, {
                query,
                scopePath,
                exact,
                kind,
                limit,
            });
            if (matches.length === 0) {
                return fail(this.name, "NOT_FOUND", `No symbols matched "${query}"`, {
                    query,
                    path: scopePath,
                });
            }
            return ok(this.name, matches.map((match) => formatSymbolMatch(context.cwd, match)).join("\n\n"), {
                query,
                count: matches.length,
                path: scopePath,
                exact,
                kind,
                indexedFiles: workspace.fileNames.length,
                skippedLargeFiles: workspace.skippedLargeFiles,
            });
        }
        finally {
            workspace.dispose();
        }
    },
};
export const findReferencesTool = {
    name: "find_references",
    description: "Find semantic references to a JS/TS symbol using the TypeScript language service.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["symbol"],
        properties: {
            symbol: {
                type: "string",
                description: "Exact symbol name to resolve before searching for references.",
            },
            path: {
                type: "string",
                description: "Optional file or directory path relative to the workspace root to anchor or filter the search.",
            },
            kind: {
                type: "string",
                description: "Optional symbol kind filter such as function, class, interface, type, enum, variable, method, property, or namespace.",
            },
            include_declaration: {
                type: "string",
                enum: ["true", "false"],
                description: "Whether to include the original declaration in the returned references.",
            },
            limit: {
                type: "string",
                description: "Optional maximum number of references to return as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const symbol = String(input.symbol ?? "").trim();
        const pathFilter = String(input.path ?? "").trim();
        const kind = String(input.kind ?? "").trim() || undefined;
        const includeDeclaration = String(input.include_declaration ?? "false") === "true";
        const requestedLimit = Number.parseInt(String(input.limit ?? "50"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
        if (!symbol) {
            return fail(this.name, "INVALID_INPUT", "Missing symbol");
        }
        let scopePath;
        try {
            scopePath = pathFilter ? resolveWorkspacePath(context.cwd, pathFilter) : undefined;
        }
        catch (error) {
            return fail(this.name, "INVALID_PATH", error instanceof Error ? error.message : "Invalid path");
        }
        const workspace = await createCodeWorkspace(context.cwd);
        try {
            if (workspace.fileNames.length === 0) {
                return fail(this.name, "NO_SOURCE_FILES", "No supported JS/TS source files were found in the workspace");
            }
            const result = findReferences(workspace, {
                symbol,
                scopePath,
                kind,
                includeDeclaration,
                limit,
            });
            if (!result) {
                return fail(this.name, "NOT_FOUND", `Could not resolve symbol "${symbol}"`, {
                    symbol,
                    path: scopePath,
                });
            }
            const lines = [
                `Declaration`,
                formatSymbolMatch(context.cwd, result.declaration),
            ];
            if (result.references.length === 0) {
                lines.push("No references found.");
            }
            else {
                lines.push("References");
                lines.push(result.references.map((reference) => formatReference(context.cwd, reference)).join("\n\n"));
            }
            return ok(this.name, lines.join("\n\n"), {
                symbol,
                count: result.references.length,
                path: scopePath,
                kind,
                includeDeclaration,
                indexedFiles: workspace.fileNames.length,
                skippedLargeFiles: workspace.skippedLargeFiles,
            });
        }
        finally {
            workspace.dispose();
        }
    },
};
export const listExportsTool = {
    name: "list_exports",
    description: "List exports from a JS/TS file using AST parsing, including re-exports and default exports when present.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
            path: {
                type: "string",
                description: "Path to the JS/TS file relative to the workspace root.",
            },
        },
    },
    async execute(input, context) {
        const relativePath = String(input.path ?? "").trim();
        if (!relativePath) {
            return fail(this.name, "INVALID_INPUT", "Missing path");
        }
        let filePath;
        try {
            filePath = resolveWorkspacePath(context.cwd, relativePath);
        }
        catch (error) {
            return fail(this.name, "INVALID_PATH", error instanceof Error ? error.message : "Invalid path");
        }
        const workspace = await createCodeWorkspace(context.cwd);
        try {
            const exports = listExports(workspace, filePath);
            if (exports.length === 0) {
                return fail(this.name, "NO_EXPORTS", `No exports found in ${relativePath}`, {
                    path: filePath,
                });
            }
            return ok(this.name, exports.map((item) => formatExport(context.cwd, filePath, item)).join("\n\n"), {
                path: filePath,
                count: exports.length,
                indexedFiles: workspace.fileNames.length,
            });
        }
        finally {
            workspace.dispose();
        }
    },
};
export const listImportsTool = {
    name: "list_imports",
    description: "List imports in a JS/TS file using AST parsing, including ESM and simple require() bindings.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
            path: {
                type: "string",
                description: "Path to the JS/TS file relative to the workspace root.",
            },
        },
    },
    async execute(input, context) {
        const relativePath = String(input.path ?? "").trim();
        if (!relativePath) {
            return fail(this.name, "INVALID_INPUT", "Missing path");
        }
        let filePath;
        try {
            filePath = resolveWorkspacePath(context.cwd, relativePath);
        }
        catch (error) {
            return fail(this.name, "INVALID_PATH", error instanceof Error ? error.message : "Invalid path");
        }
        const workspace = await createCodeWorkspace(context.cwd);
        try {
            const imports = listImports(workspace, filePath);
            if (imports.length === 0) {
                return fail(this.name, "NO_IMPORTS", `No imports found in ${relativePath}`, {
                    path: filePath,
                });
            }
            return ok(this.name, imports.map((item) => formatImport(context.cwd, filePath, item)).join("\n\n"), {
                path: filePath,
                count: imports.length,
                indexedFiles: workspace.fileNames.length,
            });
        }
        finally {
            workspace.dispose();
        }
    },
};
export const astEditTool = {
    name: "ast_edit",
    description: "Perform AST-aware JS/TS edits such as symbol renames, import updates, and declaration replacement.",
    permissionLevel: "edit",
    inputSchema: {
        type: "object",
        required: ["action", "path"],
        properties: {
            action: {
                type: "string",
                enum: ["rename_symbol", "add_import", "remove_import", "replace_symbol_declaration"],
                description: "AST edit action to perform.",
            },
            path: {
                type: "string",
                description: "Path to the target JS/TS file relative to the workspace root.",
            },
            symbol: {
                type: "string",
                description: "Symbol name used by rename_symbol or replace_symbol_declaration.",
            },
            symbol_kind: {
                type: "string",
                description: "Optional symbol kind filter for rename_symbol or replace_symbol_declaration.",
            },
            new_name: {
                type: "string",
                description: "New symbol name used by rename_symbol.",
            },
            module_specifier: {
                type: "string",
                description: "Module specifier used by add_import or remove_import.",
            },
            default_import: {
                type: "string",
                description: "Optional default import name for add_import.",
            },
            namespace_import: {
                type: "string",
                description: "Optional namespace import alias for add_import.",
            },
            named_imports: {
                type: "array",
                description: "Optional named imports for add_import, like [\"foo\", \"bar as baz\"].",
                items: {
                    type: "string",
                },
            },
            type_only: {
                type: "string",
                enum: ["true", "false"],
                description: "Whether add_import should create a type-only import.",
            },
            binding_name: {
                type: "string",
                description: "Optional local binding name to remove from an import declaration.",
            },
            replacement: {
                type: "string",
                description: "Replacement declaration text for replace_symbol_declaration.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const action = String(input.action ?? "").trim();
        const relativePath = String(input.path ?? "").trim();
        if (!action || !relativePath) {
            return fail(this.name, "INVALID_INPUT", "Missing action or path");
        }
        let filePath;
        try {
            filePath = resolveWorkspacePath(context.cwd, relativePath);
        }
        catch (error) {
            return fail(this.name, "INVALID_PATH", error instanceof Error ? error.message : "Invalid path");
        }
        const workspace = await createCodeWorkspace(context.cwd);
        try {
            const result = performAstEdit(workspace, {
                action,
                path: filePath,
                symbol: typeof input.symbol === "string" ? input.symbol : undefined,
                symbolKind: typeof input.symbol_kind === "string" ? input.symbol_kind : undefined,
                newName: typeof input.new_name === "string" ? input.new_name : undefined,
                moduleSpecifier: typeof input.module_specifier === "string" ? input.module_specifier : undefined,
                defaultImport: typeof input.default_import === "string" ? input.default_import : undefined,
                namespaceImport: typeof input.namespace_import === "string" ? input.namespace_import : undefined,
                namedImports: Array.isArray(input.named_imports)
                    ? input.named_imports.filter((value) => typeof value === "string")
                    : undefined,
                typeOnly: String(input.type_only ?? "false") === "true",
                bindingName: typeof input.binding_name === "string" ? input.binding_name : undefined,
                replacement: typeof input.replacement === "string" ? input.replacement : undefined,
            });
            const writeResult = await writeTextFiles(context, this.name, result.changes, result.summary);
            if (!writeResult.ok) {
                return writeResult;
            }
            return ok(this.name, `${result.summary}\n${writeResult.content}`, {
                ...writeResult.metadata,
                action,
                indexedFiles: workspace.fileNames.length,
                skippedLargeFiles: workspace.skippedLargeFiles,
            });
        }
        catch (error) {
            return fail(this.name, "AST_EDIT_FAILED", error instanceof Error ? error.message : "Unknown AST edit error");
        }
        finally {
            workspace.dispose();
        }
    },
};
export const searchTextTool = {
    name: "search_text",
    description: "Search for text in files under the current workspace using ripgrep when available, with a built-in fallback.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
            query: {
                type: "string",
                description: "The text or regex pattern to search for.",
            },
        },
    },
    async execute(input, context) {
        const query = String(input.query ?? "");
        if (!query) {
            return fail(this.name, "INVALID_INPUT", "Missing search query");
        }
        const rgResult = await spawnAndCapture("rg", ["-n", "--hidden", "--glob", "!.git", query, "."], context.cwd);
        if (rgResult.exitCode === -1 && rgResult.stderr.includes("ENOENT")) {
            return searchTextFallback(context.cwd, query);
        }
        if (rgResult.exitCode === 0 || rgResult.exitCode === 1) {
            return ok(this.name, rgResult.stdout || "No matches found.", {
                stderr: rgResult.stderr,
                exitCode: rgResult.exitCode,
                engine: "rg",
            });
        }
        return fail(this.name, "SEARCH_FAILED", rgResult.stderr || `rg exited with code ${rgResult.exitCode}`);
    },
};
export const replaceInFileTool = {
    name: "replace_in_file",
    description: "Replace a string in a text file, with optional all-occurrences mode, and preview the resulting diff.",
    permissionLevel: "edit",
    inputSchema: {
        type: "object",
        required: ["path", "find", "replace"],
        properties: {
            path: {
                type: "string",
                description: "Path to the file relative to the workspace root.",
            },
            find: {
                type: "string",
                description: "Exact text to find.",
            },
            replace: {
                type: "string",
                description: "Replacement text.",
            },
            replace_all: {
                type: "string",
                enum: ["true", "false"],
                description: "Whether to replace all occurrences instead of just the first.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const relativePath = String(input.path ?? "");
        const find = String(input.find ?? "");
        const replace = String(input.replace ?? "");
        const replaceAll = String(input.replace_all ?? "false") === "true";
        if (!relativePath || !find) {
            return fail(this.name, "INVALID_INPUT", "Missing path or find text");
        }
        try {
            const filePath = resolveWorkspacePath(context.cwd, relativePath);
            const existing = await fs.readFile(filePath, "utf8");
            if (!existing.includes(find)) {
                return fail(this.name, "NO_MATCH", `Text not found in ${relativePath}`, { path: filePath });
            }
            const nextContent = replaceAll ? existing.split(find).join(replace) : existing.replace(find, replace);
            return writeTextFile(context, this.name, relativePath, nextContent, "Replace text in");
        }
        catch (error) {
            return fail(this.name, "REPLACE_FAILED", error instanceof Error ? error.message : "Unknown replace error");
        }
    },
};
export const gitStatusTool = {
    name: "git_status",
    description: "Show the current git status for the workspace, including branch and changed files when available.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {},
    },
    async execute(_input, context) {
        const gitRoot = await resolveGitRoot(context.cwd);
        if (!gitRoot) {
            return ok(this.name, "Workspace is not a git repository. Review the codebase by inspecting files directly.", {
                gitRepo: false,
                informational: true,
                count: 0,
                files: [],
            });
        }
        const result = await spawnAndCapture("git", ["status", "--short", "--branch"], context.cwd);
        if (!result.ok && result.exitCode !== 0) {
            return fail(this.name, "GIT_STATUS_FAILED", result.stderr || "git status failed");
        }
        return ok(this.name, result.stdout.trim() || "Working tree clean.", {
            exitCode: result.exitCode,
            stderr: result.stderr,
        });
    },
};
export const gitChangedFilesTool = {
    name: "git_changed_files",
    description: "List changed git files with status and line-level stats to support code review workflows.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            limit: {
                type: "string",
                description: "Optional maximum number of changed files to return as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const requestedLimit = Number.parseInt(String(input.limit ?? "100"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 250)) : 100;
        const collected = await collectGitChangedFiles(context.cwd);
        if (!collected) {
            return ok(this.name, "Workspace is not a git repository, so there is no git change list. Inspect the workspace files directly instead.", {
                gitRepo: false,
                informational: true,
                count: 0,
                files: [],
            });
        }
        const files = collected.files.slice(0, limit);
        if (files.length === 0) {
            return ok(this.name, "No changed files found.", {
                gitRoot: collected.gitRoot,
                count: 0,
                files: [],
            });
        }
        return ok(this.name, files.map((file) => formatChangedFileLine(file)).join("\n"), {
            gitRoot: collected.gitRoot,
            count: collected.files.length,
            returned: files.length,
            files: files.map((file) => file.path),
        });
    },
};
export const gitChangedFileSummariesTool = {
    name: "git_changed_file_summaries",
    description: "Summarize each changed git file with status, line counts, and touched diff regions for review.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Optional file or directory path relative to the workspace root to limit summaries.",
            },
            limit: {
                type: "string",
                description: "Optional maximum number of changed files to summarize as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const collected = await collectGitChangedFiles(context.cwd);
        if (!collected) {
            return ok(this.name, "Workspace is not a git repository, so there are no git diff summaries available. Inspect files directly instead.", {
                gitRepo: false,
                informational: true,
                count: 0,
                files: [],
            });
        }
        const relativePath = String(input.path ?? "").trim();
        const requestedLimit = Number.parseInt(String(input.limit ?? "12"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 40)) : 12;
        const normalizedFilter = relativePath.replace(/\\/g, "/");
        const matchingFiles = collected.files
            .filter((file) => {
            if (!normalizedFilter) {
                return true;
            }
            return file.path === normalizedFilter || file.path.startsWith(`${normalizedFilter}/`);
        })
            .slice(0, limit);
        if (matchingFiles.length === 0) {
            return ok(this.name, "No changed files matched the requested path.", {
                gitRoot: collected.gitRoot,
                count: 0,
                files: [],
            });
        }
        const blocks = [];
        for (const file of matchingFiles) {
            const args = ["diff", "--unified=0", "--find-renames"];
            if (!file.untracked) {
                args.push("HEAD");
            }
            args.push("--", file.path);
            const diffResult = await spawnAndCapture("git", args, context.cwd);
            const diffText = diffResult.stdout.trim();
            const hunkHeaders = parseDiffHunkHeaders(diffText);
            const changedLines = extractChangedLinePreview(diffText);
            let preview = "";
            if (file.untracked) {
                try {
                    const filePath = resolveWorkspacePath(context.cwd, file.path);
                    const content = await fs.readFile(filePath, "utf8");
                    preview = truncateContent(content, 600).text;
                }
                catch {
                    preview = "";
                }
            }
            const blockLines = [
                `${file.path}`,
                `status: ${file.statusLabel}${file.previousPath ? ` (${file.previousPath} -> ${file.path})` : ""}`,
                `line changes: ${file.binary ? "binary" : `+${String(file.additions ?? 0)} -${String(file.deletions ?? 0)}`}`,
            ];
            if (hunkHeaders.length > 0) {
                blockLines.push("touched regions:");
                blockLines.push(...hunkHeaders.slice(0, 6).map((header) => `- ${header}`));
            }
            if (changedLines.length > 0) {
                blockLines.push("changed lines:");
                blockLines.push(...changedLines.map((line) => `  ${line}`));
            }
            else if (preview) {
                blockLines.push("new file preview:");
                blockLines.push(preview);
            }
            blocks.push(blockLines.join("\n"));
        }
        return ok(this.name, blocks.join("\n\n"), {
            gitRoot: collected.gitRoot,
            count: collected.files.length,
            returned: matchingFiles.length,
            files: matchingFiles.map((file) => file.path),
        });
    },
};
export const gitDiffTool = {
    name: "git_diff",
    description: "Show a git diff for the workspace or for a specific file/path, optionally against a given revision.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Optional file or directory path relative to the workspace root.",
            },
            ref: {
                type: "string",
                description: "Optional revision, branch, or commit to diff against.",
            },
        },
    },
    async execute(input, context) {
        const gitRoot = await resolveGitRoot(context.cwd);
        if (!gitRoot) {
            return ok(this.name, "Workspace is not a git repository, so there is no git diff to inspect. Review files directly instead.", {
                gitRepo: false,
                informational: true,
                path: String(input.path ?? "").trim() || undefined,
            });
        }
        const relativePath = String(input.path ?? "").trim();
        const ref = String(input.ref ?? "").trim();
        const args = ["diff", "--stat", "--patch", "--unified=3"];
        if (ref) {
            args.push(ref);
        }
        if (relativePath) {
            const targetPath = resolveWorkspacePath(context.cwd, relativePath);
            args.push("--", relativeToWorkspace(context.cwd, targetPath));
        }
        const result = await spawnAndCapture("git", args, context.cwd);
        if (!result.ok && result.exitCode !== 0) {
            return fail(this.name, "GIT_DIFF_FAILED", result.stderr || "git diff failed");
        }
        const content = (result.stdout || "No diff found.").trim() || "No diff found.";
        return ok(this.name, content, {
            exitCode: result.exitCode,
            stderr: result.stderr,
            ref: ref || undefined,
            path: relativePath || undefined,
        });
    },
};
export const estimateTestImpactTool = {
    name: "estimate_test_impact",
    description: "Estimate which tests and test commands are most relevant for the current changed files.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            paths: {
                type: "array",
                items: {
                    type: "string",
                },
                description: "Optional list of changed file paths relative to the workspace root. Defaults to current git changes.",
            },
            max_tests: {
                type: "string",
                description: "Optional maximum number of candidate tests to return as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const rawPaths = Array.isArray(input.paths) ? input.paths : [];
        const requestedPaths = rawPaths.filter((value) => typeof value === "string" && value.trim().length > 0);
        const requestedMaxTests = Number.parseInt(String(input.max_tests ?? "20"), 10);
        const maxTests = Number.isFinite(requestedMaxTests) ? Math.max(1, Math.min(requestedMaxTests, 60)) : 20;
        const collectedChanges = requestedPaths.length > 0 ? null : await collectGitChangedFiles(context.cwd);
        const changedPaths = requestedPaths.length > 0
            ? requestedPaths.map((value) => value.replace(/\\/g, "/"))
            : collectedChanges?.files.map((file) => file.path) ?? [];
        if (requestedPaths.length === 0 && !collectedChanges) {
            return ok(this.name, "Workspace is not a git repository, so there is no git change set to estimate test impact from. Inspect the codebase directly or provide file paths.", {
                gitRepo: false,
                informational: true,
                candidateTestCount: 0,
                changedPaths: [],
                testCommands: await detectLikelyTestCommands(context.cwd),
            });
        }
        if (changedPaths.length === 0) {
            return ok(this.name, "No changed files were found to estimate test impact.", {
                riskLevel: "low",
                candidateTestCount: 0,
            });
        }
        const workspaceFiles = (await findFiles(workspaceRoot(context.cwd))).map((filePath) => relativeToWorkspace(context.cwd, filePath).replace(/\\/g, "/"));
        const existingFiles = new Set(workspaceFiles);
        const directTestCandidates = new Set();
        const dependentSources = new Set();
        const dependentTestCandidates = new Set();
        for (const changedPath of changedPaths) {
            if (isTestFilePath(changedPath)) {
                directTestCandidates.add(changedPath);
                continue;
            }
            for (const candidate of likelyTestPathCandidates(changedPath)) {
                if (existingFiles.has(candidate)) {
                    directTestCandidates.add(candidate);
                }
            }
            if (!filePathLikelyNeedsTests(changedPath)) {
                continue;
            }
            const changedNoExt = stripKnownExtensions(changedPath);
            const importNeedles = uniqueStrings([
                changedNoExt,
                changedNoExt.replace(/\/index$/, ""),
                path.posix.basename(changedNoExt),
            ]).filter((value) => value.length > 1);
            for (const candidateFile of workspaceFiles) {
                if (candidateFile === changedPath || !filePathLikelyNeedsTests(candidateFile) || isTestFilePath(candidateFile)) {
                    continue;
                }
                if (!SOURCE_CODE_EXTENSIONS.has(path.extname(candidateFile).toLowerCase())) {
                    continue;
                }
                try {
                    const filePath = resolveWorkspacePath(context.cwd, candidateFile);
                    const content = await fs.readFile(filePath, "utf8");
                    if (importNeedles.some((needle) => content.includes(needle))) {
                        dependentSources.add(candidateFile);
                        for (const candidate of likelyTestPathCandidates(candidateFile)) {
                            if (existingFiles.has(candidate)) {
                                dependentTestCandidates.add(candidate);
                            }
                        }
                    }
                }
                catch {
                    // Ignore unreadable files during heuristic scanning.
                }
            }
        }
        const candidateTests = uniqueStrings([
            ...directTestCandidates,
            ...dependentTestCandidates,
        ]).slice(0, maxTests);
        const testCommands = await detectLikelyTestCommands(context.cwd);
        const highRiskPatterns = [
            /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
            /(^|\/)(tsconfig|vite\.config|vitest\.config|jest\.config|webpack\.config|rollup\.config|pyproject\.toml|Cargo\.toml|go\.mod)/i,
            /(^|\/)(src|lib|app|server|api|core)\//i,
        ];
        const isHighRisk = changedPaths.length >= 10 || changedPaths.some((changedPath) => highRiskPatterns.some((pattern) => pattern.test(changedPath)));
        const riskLevel = isHighRisk ? "high" : candidateTests.length > 0 || dependentSources.size > 0 ? "moderate" : "low";
        const lines = [
            `risk level: ${riskLevel}`,
            `changed files reviewed: ${changedPaths.length}`,
            `direct candidate tests: ${directTestCandidates.size}`,
            `dependent source files: ${dependentSources.size}`,
            `candidate tests returned: ${candidateTests.length}`,
        ];
        if (candidateTests.length > 0) {
            lines.push("candidate tests:");
            lines.push(...candidateTests.map((candidate) => `- ${candidate}`));
        }
        if (dependentSources.size > 0) {
            lines.push("related source files:");
            lines.push(...[...dependentSources].slice(0, 12).map((candidate) => `- ${candidate}`));
        }
        if (testCommands.length > 0) {
            lines.push("likely test commands:");
            lines.push(...testCommands.map((command) => `- ${command}`));
        }
        return ok(this.name, lines.join("\n"), {
            riskLevel,
            changedPaths,
            candidateTests,
            candidateTestCount: candidateTests.length,
            dependentSourceCount: dependentSources.size,
            testCommands,
        });
    },
};
export const gitRecentCommitsTool = {
    name: "git_recent_commits",
    description: "Show recent git commits for the workspace to support git-aware planning and review.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        properties: {
            limit: {
                type: "string",
                description: "Optional maximum number of commits to return as a stringified integer.",
            },
        },
    },
    async execute(input, context) {
        const gitRoot = await resolveGitRoot(context.cwd);
        if (!gitRoot) {
            return ok(this.name, "Workspace is not a git repository, so there is no commit history to inspect.", {
                gitRepo: false,
                informational: true,
                count: 0,
            });
        }
        const requestedLimit = Number.parseInt(String(input.limit ?? "10"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 30)) : 10;
        const args = ["log", `-n${String(limit)}`, "--date=short", "--pretty=format:%h %ad %an %s"];
        const result = await spawnAndCapture("git", args, context.cwd);
        if (!result.ok && result.exitCode !== 0) {
            return fail(this.name, "GIT_LOG_FAILED", result.stderr || "git log failed");
        }
        return ok(this.name, result.stdout.trim() || "No commits found.", {
            exitCode: result.exitCode,
            stderr: result.stderr,
            count: limit,
        });
    },
};
export const webSearchTool = {
    name: "web_search",
    description: "Search the public web for recent information and return a short list of result titles and URLs.",
    permissionLevel: "execute",
    inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
            query: {
                type: "string",
                description: "Search query to run on the public web.",
            },
            limit: {
                type: "string",
                description: "Optional maximum number of results to return as a stringified integer.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const query = String(input.query ?? "").trim();
        const requestedLimit = Number.parseInt(String(input.limit ?? "5"), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 10)) : 5;
        if (!query) {
            return fail(this.name, "INVALID_INPUT", "Missing search query");
        }
        const approved = await context.approve(this.name, `search the web for: ${query}`);
        if (!approved) {
            return fail(this.name, "PERMISSION_DENIED", "User declined web search", { query });
        }
        try {
            const html = await fetchTextFromUrl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
            const results = extractSearchResultsFromHtml(html, limit);
            if (results.length === 0) {
                return fail(this.name, "NO_RESULTS", "No search results found", { query });
            }
            return ok(this.name, results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}`).join("\n\n"), {
                query,
                count: results.length,
                engine: "duckduckgo-lite",
            });
        }
        catch (error) {
            return fail(this.name, "WEB_SEARCH_FAILED", error instanceof Error ? error.message : "Unknown web search error", {
                query,
            });
        }
    },
};
export const fetchUrlTool = {
    name: "fetch_url",
    description: "Fetch a URL and return readable text content from the page.",
    permissionLevel: "execute",
    inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
            url: {
                type: "string",
                description: "HTTP or HTTPS URL to fetch.",
            },
            max_chars: {
                type: "string",
                description: "Optional maximum number of characters to return as a stringified integer.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const url = String(input.url ?? "").trim();
        const requestedMaxChars = Number.parseInt(String(input.max_chars ?? "6000"), 10);
        const maxChars = Number.isFinite(requestedMaxChars) ? Math.max(500, Math.min(requestedMaxChars, 20_000)) : 6000;
        if (!/^https?:\/\//i.test(url)) {
            return fail(this.name, "INVALID_INPUT", "URL must start with http:// or https://");
        }
        const blockedReason = isBlockedNetworkTarget(url);
        if (blockedReason) {
            return fail(this.name, "BLOCKED_URL", blockedReason, { url });
        }
        const approved = await context.approve(this.name, `fetch URL: ${url}`);
        if (!approved) {
            return fail(this.name, "PERMISSION_DENIED", "User declined URL fetch", { url });
        }
        try {
            const html = await fetchTextFromUrl(url);
            const text = stripHtml(html);
            const truncated = text.length > maxChars;
            const content = truncated ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]` : text;
            return ok(this.name, content || "No readable text content found.", {
                url,
                maxChars,
                truncated,
            });
        }
        catch (error) {
            return fail(this.name, "FETCH_URL_FAILED", error instanceof Error ? error.message : "Unknown fetch error", {
                url,
            });
        }
    },
};
export const writeFileTool = {
    name: "write_file",
    description: "Write a UTF-8 text file inside the workspace, creating parent directories when needed.",
    permissionLevel: "edit",
    inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
            path: {
                type: "string",
                description: "Path to the file relative to the workspace root.",
            },
            content: {
                type: "string",
                description: "Full file contents to write.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const relativePath = String(input.path ?? "");
        const content = String(input.content ?? "");
        if (!relativePath) {
            return fail(this.name, "INVALID_INPUT", "Missing path");
        }
        return writeTextFile(context, this.name, relativePath, content, "Write file");
    },
};
export const createFileTool = {
    name: "create_file",
    description: "Create a new UTF-8 text file inside the workspace and fail if it already exists.",
    permissionLevel: "edit",
    inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
            path: {
                type: "string",
                description: "Path to the file relative to the workspace root.",
            },
            content: {
                type: "string",
                description: "Full file contents to write.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const relativePath = String(input.path ?? "");
        const content = String(input.content ?? "");
        if (!relativePath) {
            return fail(this.name, "INVALID_INPUT", "Missing path");
        }
        try {
            const filePath = resolveWorkspacePath(context.cwd, relativePath);
            if (await pathExists(filePath)) {
                return fail(this.name, "FILE_EXISTS", `File already exists: ${relativePath}`, { path: filePath });
            }
        }
        catch (error) {
            return fail(this.name, "WRITE_FAILED", error instanceof Error ? error.message : "Unknown create error");
        }
        return writeTextFile(context, this.name, relativePath, content, "Create file");
    },
};
export const startCommandSessionTool = {
    name: "start_command_session",
    description: "Start a long-running command session that can be read from and written to later.",
    permissionLevel: "execute",
    inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
            command: {
                type: "string",
                description: "Shell command to start in the workspace.",
            },
            session_id: {
                type: "string",
                description: "Optional stable session identifier.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const command = String(input.command ?? "");
        const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
        if (!command) {
            return fail(this.name, "INVALID_INPUT", "Missing command");
        }
        const approved = await context.approve(this.name, command);
        if (!approved) {
            return fail(this.name, "PERMISSION_DENIED", "User declined command session start", { command });
        }
        const session = await createCommandSession(context.cwd, command, sessionId);
        return ok(this.name, `Started command session ${session.id}`, {
            sessionId: session.id,
            command,
            logPath: session.logPath,
        });
    },
};
export const readProcessOutputTool = {
    name: "read_process_output",
    description: "Read buffered stdout and stderr from a previously started command session.",
    permissionLevel: "read",
    inputSchema: {
        type: "object",
        required: ["session_id"],
        properties: {
            session_id: {
                type: "string",
                description: "Session identifier returned by start_command_session.",
            },
        },
    },
    async execute(input) {
        const sessionId = String(input.session_id ?? "");
        const session = getCommandSession(sessionId);
        if (!session) {
            return fail(this.name, "UNKNOWN_SESSION", `Command session not found: ${sessionId}`);
        }
        const stdoutChunk = session.stdout.slice(session.lastReadStdout);
        const stderrChunk = session.stderr.slice(session.lastReadStderr);
        session.lastReadStdout = session.stdout.length;
        session.lastReadStderr = session.stderr.length;
        const content = [`[stdout]`, stdoutChunk || "(no new stdout)", `[stderr]`, stderrChunk || "(no new stderr)"].join("\n");
        return ok(this.name, content, {
            sessionId,
            exitCode: session.exitCode,
            running: session.exitCode === null,
        });
    },
};
export const sendProcessInputTool = {
    name: "send_process_input",
    description: "Send stdin text to a previously started command session.",
    permissionLevel: "execute",
    inputSchema: {
        type: "object",
        required: ["session_id", "input"],
        properties: {
            session_id: {
                type: "string",
                description: "Session identifier returned by start_command_session.",
            },
            input: {
                type: "string",
                description: "Text to write to the process stdin.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const sessionId = String(input.session_id ?? "");
        const text = String(input.input ?? "");
        const session = getCommandSession(sessionId);
        if (!session) {
            return fail(this.name, "UNKNOWN_SESSION", `Command session not found: ${sessionId}`);
        }
        const approved = await context.approve(this.name, `send input to ${sessionId}: ${text}`);
        if (!approved) {
            return fail(this.name, "PERMISSION_DENIED", "User declined process input", { sessionId });
        }
        if (!session.process.stdin) {
            return fail(this.name, "NO_STDIN", `Command session ${sessionId} does not accept stdin`, { sessionId });
        }
        session.process.stdin.write(text);
        return ok(this.name, `Sent input to ${sessionId}`, { sessionId });
    },
};
export const closeCommandSessionTool = {
    name: "close_command_session",
    description: "Terminate a running command session and persist its final metadata.",
    permissionLevel: "execute",
    inputSchema: {
        type: "object",
        required: ["session_id"],
        properties: {
            session_id: {
                type: "string",
                description: "Session identifier returned by start_command_session.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const sessionId = String(input.session_id ?? "");
        const session = getCommandSession(sessionId);
        if (!session) {
            return fail(this.name, "UNKNOWN_SESSION", `Command session not found: ${sessionId}`);
        }
        const approved = await context.approve(this.name, `close command session ${sessionId}`);
        if (!approved) {
            return fail(this.name, "PERMISSION_DENIED", "User declined session termination", { sessionId });
        }
        session.process.kill();
        session.exitCode ??= -1;
        await persistCommandSession(session);
        commandSessions.delete(sessionId);
        return ok(this.name, `Closed ${sessionId}`, { sessionId });
    },
};
export const applyPatchTool = {
    name: "apply_patch",
    description: "Apply a unified diff patch to workspace files using git-apply style validation before writing.",
    permissionLevel: "edit",
    inputSchema: {
        type: "object",
        required: ["patch"],
        properties: {
            patch: {
                type: "string",
                description: "Unified diff patch text with ---/+++ headers and @@ hunks.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const patch = String(input.patch ?? "");
        if (!patch.trim()) {
            return fail(this.name, "INVALID_INPUT", "Missing patch");
        }
        try {
            const { changes, validation } = await materializePatchChanges(context.cwd, patch);
            if (!validation.ok) {
                return fail(this.name, "VALIDATION_FAILED", `Patch validation failed:\n${validation.issues.join("\n")}`, {
                    validationIssues: validation.issues,
                    validatedFiles: validation.validatedFiles,
                });
            }
            return writeTextFiles(context, this.name, changes, "Apply patch to");
        }
        catch (error) {
            return fail(this.name, "PATCH_FAILED", error instanceof Error ? error.message : "Unknown patch error");
        }
    },
};
export const runCommandTool = {
    name: "run_command",
    description: "Run a shell command in the current workspace and return stdout, stderr, and exit code.",
    permissionLevel: "execute",
    inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
            command: {
                type: "string",
                description: "Shell command to run in the workspace.",
            },
            timeout_ms: {
                type: "number",
                description: "Optional command timeout in milliseconds.",
            },
        },
    },
    requiresApproval: true,
    async execute(input, context) {
        const command = String(input.command ?? "");
        const timeoutMs = typeof input.timeout_ms === "number" ? Math.max(1, input.timeout_ms) : 30_000;
        if (!command) {
            return fail(this.name, "INVALID_INPUT", "Missing command");
        }
        const approved = await context.approve(this.name, command);
        if (!approved) {
            return fail(this.name, "PERMISSION_DENIED", "User declined command execution", {
                command,
            });
        }
        return new Promise((resolve) => {
            const child = spawn(command, {
                cwd: context.cwd,
                shell: true,
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
                resolve(fail(this.name, "EXEC_FAILED", error.message, { command }));
            });
            child.on("close", (code) => {
                const content = [`$ ${command}`, stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
                resolve(ok(this.name, content || `$ ${command}`, {
                    command,
                    exitCode: code ?? 0,
                    stdout,
                    stderr,
                }));
            });
            const timer = setTimeout(() => {
                child.kill();
                resolve(fail(this.name, "COMMAND_TIMEOUT", `Command timed out after ${timeoutMs}ms`, { command }));
            }, timeoutMs);
            child.on("close", () => {
                clearTimeout(timer);
            });
            child.on("error", () => {
                clearTimeout(timer);
            });
        });
    },
};
export function getDefaultTools() {
    return [
        getCwdTool,
        inspectPathTool,
        listFilesTool,
        listTreeTool,
        findSymbolTool,
        findReferencesTool,
        listExportsTool,
        listImportsTool,
        readFileTool,
        readManyFilesTool,
        astEditTool,
        searchTextTool,
        replaceInFileTool,
        gitStatusTool,
        gitChangedFilesTool,
        gitChangedFileSummariesTool,
        gitDiffTool,
        estimateTestImpactTool,
        gitRecentCommitsTool,
        webSearchTool,
        fetchUrlTool,
        createFileTool,
        writeFileTool,
        applyPatchTool,
        startCommandSessionTool,
        readProcessOutputTool,
        sendProcessInputTool,
        closeCommandSessionTool,
        runCommandTool,
    ];
}
//# sourceMappingURL=index.js.map