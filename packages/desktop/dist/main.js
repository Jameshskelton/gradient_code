import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { buildAgentSystemPrompt, deleteSessionsForWorkspace, deleteSession, loadProjectNotes, resolveProjectNotesPath, ToolRegistry, listSessions, loadGradientCodeConfig, loadLatestSession, loadSession, runAgent, saveGradientCodeConfig, saveSession, writeTranscript, } from "@gradient-code/core";
import { AVAILABLE_GRADIENT_MODELS, GradientResponsesClient, resolveModelCapabilityProfile, } from "@gradient-code/provider-gradient";
import { getDefaultTools } from "@gradient-code/tools";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appIconPath = path.resolve(__dirname, "../../../logo.png");
const MAX_FILE_PREVIEW_BYTES = 200_000;
const IGNORED_BROWSER_DIRS = new Set([
    ".git",
    "node_modules",
    ".gradient-code",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
]);
const IGNORED_BROWSER_FILES = new Set([".DS_Store"]);
let mainWindow = null;
let activeRun = false;
let activeRunAbortController = null;
const pendingApprovals = new Map();
const approvalRulesThisRun = new Map();
const NETWORK_APPROVAL_TOOL_NAMES = new Set(["web_search", "fetch_url"]);
const HIGH_RISK_COMMAND_PATTERN = /\b(rm|sudo|chmod|chown|dd|mkfs|launchctl|killall|pkill)\b|git\s+(reset|clean)\b|npm\s+publish\b|pnpm\s+publish\b|yarn\s+publish\b|cargo\s+publish\b|curl\b.*\|\s*(sh|bash|zsh)\b|wget\b.*\|\s*(sh|bash|zsh)\b|[>|]{2}|[|]\s*(sh|bash|zsh)\b/i;
const MEDIUM_RISK_COMMAND_PATTERN = /\b(npm|pnpm|yarn|bun|cargo|go|pytest|vitest|jest|playwright|cypress|make|docker|kubectl|terraform|gradle|mvn|swift|xcodebuild)\b/i;
const SENSITIVE_WRITE_PATH_PATTERN = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Dockerfile|docker-compose\.(yml|yaml)|\.env($|\.)|\.github\/|tsconfig(\.[^.]+)?\.json$|vite\.config|webpack\.config|rollup\.config|eslint\.config|prettier\.config|turbo\.json$|vercel\.json$|pnpm-workspace\.yaml$)/i;
function normalizeModelName(model) {
    const trimmed = model.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "glm-5") {
        return "glm-5";
    }
    if (lowered === "nemotron-super") {
        return "nvidia-nemotron-3-super-120b";
    }
    return trimmed;
}
function parseDotEnv(raw) {
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const index = trimmed.indexOf("=");
        if (index === -1) {
            continue;
        }
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim();
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}
async function maybeLoadEnv(projectRoot) {
    const fs = await import("node:fs/promises");
    const envPath = path.join(projectRoot, ".env");
    try {
        const raw = await fs.readFile(envPath, "utf8");
        parseDotEnv(raw);
    }
    catch {
        // Ignore missing files.
    }
}
function sendEvent(payload) {
    mainWindow?.webContents.send("desktop:event", payload);
}
function isSafeExternalUrl(urlText) {
    try {
        const url = new URL(urlText);
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}
function summarizeToolResult(result) {
    if (!result.ok) {
        return `${result.error.code}: ${result.error.message}`;
    }
    if (result.metadata?.gitRepo === false) {
        return "no git repo; falling back to file inspection";
    }
    if (typeof result.metadata?.riskLevel === "string") {
        const candidates = typeof result.metadata?.candidateTestCount === "number" ? result.metadata.candidateTestCount : 0;
        const commands = Array.isArray(result.metadata?.testCommands) ? result.metadata.testCommands.length : 0;
        return `risk ${result.metadata.riskLevel}: ${candidates} candidate tests, ${commands} likely commands`;
    }
    if (Array.isArray(result.metadata?.files)) {
        const returned = typeof result.metadata?.returned === "number" ? result.metadata.returned : result.metadata.files.length;
        const total = typeof result.metadata?.count === "number" ? result.metadata.count : result.metadata.files.length;
        return `${returned}/${total} files: ${result.metadata.files.join(", ")}`;
    }
    if (typeof result.metadata?.path === "string") {
        return result.metadata.changed === true ? `changed ${result.metadata.path}` : `ok ${result.metadata.path}`;
    }
    if (typeof result.metadata?.command === "string") {
        return `exit ${String(result.metadata.exitCode ?? 0)} ${result.metadata.command}`;
    }
    return result.content;
}
function isCommandToolName(toolName) {
    return [
        "run_command",
        "start_command_session",
        "read_process_output",
        "send_process_input",
        "close_command_session",
    ].includes(toolName);
}
function splitApprovalSummary(summary) {
    const normalized = String(summary || "").trim();
    if (!normalized) {
        return {
            requestText: "",
            diffText: "",
        };
    }
    const diffMatch = normalized.match(/(^diff --git .*$|^--- .*$|^@@ .*$)/m);
    if (!diffMatch || typeof diffMatch.index !== "number") {
        return {
            requestText: normalized,
            diffText: "",
        };
    }
    return {
        requestText: normalized.slice(0, diffMatch.index).trim(),
        diffText: normalized.slice(diffMatch.index).trim(),
    };
}
function extractDiffPaths(diffText) {
    const normalized = String(diffText || "");
    if (!normalized.trim()) {
        return [];
    }
    const paths = new Set();
    for (const line of normalized.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
            if (match?.[2]) {
                paths.add(match[2]);
            }
            continue;
        }
        if (line.startsWith("+++ ")) {
            const candidate = line.slice(4).trim();
            if (!candidate || candidate === "/dev/null") {
                continue;
            }
            paths.add(candidate.replace(/^b\//, ""));
        }
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
}
function normalizeApprovalText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/approval-[a-z0-9-]+/g, "<approval>")
        .replace(/session-[a-z0-9-]+/g, "<session>")
        .replace(/\/(?:users|home)\/[^\s]+/g, "<path>")
        .replace(/[a-z]:\\[^\s]+/gi, "<path>")
        .replace(/\b\d+\b/g, "<n>")
        .replace(/\s+/g, " ")
        .trim();
}
function classifyApprovalKind(toolName, diffText) {
    if (isCommandToolName(toolName)) {
        return "command";
    }
    if (extractDiffPaths(diffText).length > 0) {
        return "write";
    }
    if (NETWORK_APPROVAL_TOOL_NAMES.has(toolName)) {
        return "network";
    }
    return "generic";
}
function inferApprovalRiskLevel(approvalKind, requestText, diffPaths) {
    if (approvalKind === "command") {
        if (HIGH_RISK_COMMAND_PATTERN.test(requestText)) {
            return "high";
        }
        if (MEDIUM_RISK_COMMAND_PATTERN.test(requestText)) {
            return "medium";
        }
        return "medium";
    }
    if (approvalKind === "write") {
        if (diffPaths.length >= 5 || diffPaths.some((filePath) => SENSITIVE_WRITE_PATH_PATTERN.test(filePath))) {
            return "high";
        }
        if (diffPaths.length >= 2) {
            return "medium";
        }
        return "low";
    }
    if (approvalKind === "network") {
        return requestText.startsWith("fetch url:") ? "medium" : "low";
    }
    return "medium";
}
function buildApprovalFingerprint(approvalKind, toolName, requestText, diffPaths) {
    const normalizedRequest = normalizeApprovalText(requestText);
    if (approvalKind === "write" && diffPaths.length > 0) {
        return `${approvalKind}:${toolName}:${diffPaths.map((entry) => normalizeApprovalText(entry)).join("|")}`;
    }
    if (approvalKind === "command") {
        const command = normalizedRequest || normalizeApprovalText(toolName);
        const executable = command.split(/\s+/, 1)[0] || toolName;
        return `${approvalKind}:${toolName}:${executable}:${command}`;
    }
    return `${approvalKind}:${toolName}:${normalizedRequest}`;
}
function describeApprovalRequest(runId, toolName, summary) {
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { requestText, diffText } = splitApprovalSummary(summary);
    const diffPaths = extractDiffPaths(diffText);
    const approvalKind = classifyApprovalKind(toolName, diffText);
    const riskLevel = inferApprovalRiskLevel(approvalKind, requestText, diffPaths);
    return {
        requestId,
        runId,
        toolName,
        summary,
        requestText,
        diffText,
        approvalKind,
        riskLevel,
        fingerprint: buildApprovalFingerprint(approvalKind, toolName, requestText, diffPaths),
    };
}
function mergeUsage(existing, incoming) {
    if (!existing && !incoming) {
        return undefined;
    }
    const merged = {
        inputTokens: incoming?.inputTokens ?? existing?.inputTokens,
        outputTokens: incoming?.outputTokens ?? existing?.outputTokens,
        totalTokens: incoming?.totalTokens ?? existing?.totalTokens,
    };
    return merged;
}
function countExistingThreads(state) {
    if (!state) {
        return 0;
    }
    const runIds = [...new Set(state.events.map((event) => event.runId).filter((runId) => Boolean(runId)))];
    if (runIds.length > 0) {
        return runIds.length;
    }
    return state.events.filter((event) => event.type === "user").length;
}
function makeRunId() {
    return `run-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(36).slice(2, 8)}`;
}
function normalizePathSlashes(value) {
    return value.replace(/\\/g, "/");
}
function historyDir(cwd) {
    return path.join(cwd, ".gradient-code");
}
function isWithinWorkspace(root, targetPath) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}
function resolveWorkspacePath(root, relativePath = "") {
    const resolved = path.resolve(root, relativePath || ".");
    if (!isWithinWorkspace(root, resolved)) {
        throw new Error(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
}
function relativeWorkspacePath(root, targetPath) {
    const relative = normalizePathSlashes(path.relative(root, targetPath));
    return relative === "" ? "" : relative;
}
function shouldIgnoreBrowserEntry(name, isDirectory) {
    return isDirectory ? IGNORED_BROWSER_DIRS.has(name) : IGNORED_BROWSER_FILES.has(name);
}
async function listWorkspaceDirectory(cwd, relativePath = "") {
    const resolvedCwd = path.resolve(cwd);
    const targetPath = resolveWorkspacePath(resolvedCwd, relativePath);
    const dirents = await fs.readdir(targetPath, { withFileTypes: true });
    const entries = dirents
        .filter((entry) => !shouldIgnoreBrowserEntry(entry.name, entry.isDirectory()))
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
            return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    })
        .map((entry) => {
        const absolutePath = path.join(targetPath, entry.name);
        return {
            name: entry.name,
            path: relativeWorkspacePath(resolvedCwd, absolutePath),
            type: entry.isDirectory() ? "directory" : "file",
            hasChildren: entry.isDirectory(),
        };
    });
    return {
        path: relativeWorkspacePath(resolvedCwd, targetPath),
        entries,
    };
}
async function readWorkspaceFilePreview(cwd, relativePath) {
    const resolvedCwd = path.resolve(cwd);
    const targetPath = resolveWorkspacePath(resolvedCwd, relativePath);
    const stats = await fs.stat(targetPath);
    if (!stats.isFile()) {
        throw new Error(`Not a file: ${relativePath}`);
    }
    const handle = await fs.open(targetPath, "r");
    try {
        const bytesToRead = Math.min(stats.size, MAX_FILE_PREVIEW_BYTES);
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
        const preview = buffer.subarray(0, bytesRead);
        const isBinary = preview.includes(0);
        return {
            path: relativeWorkspacePath(resolvedCwd, targetPath),
            absolutePath: targetPath,
            content: isBinary ? "" : preview.toString("utf8"),
            isBinary,
            truncated: stats.size > MAX_FILE_PREVIEW_BYTES,
            size: stats.size,
        };
    }
    finally {
        await handle.close();
    }
}
async function openHistoryFolder(cwd) {
    const directory = historyDir(path.resolve(cwd));
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    return {
        ok: error === "",
        error: error || null,
        path: directory,
    };
}
async function clearWorkspaceHistory(cwd) {
    const resolvedCwd = path.resolve(cwd);
    const directory = historyDir(resolvedCwd);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    let cleared = false;
    for (const entry of entries) {
        if (entry.name === "project-notes.md") {
            continue;
        }
        await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
        cleared = true;
    }
    const remainingEntries = await fs.readdir(directory).catch(() => []);
    if (remainingEntries.length === 0) {
        await fs.rm(directory, { recursive: true, force: true });
    }
    const deletedGlobalSessions = await deleteSessionsForWorkspace(resolvedCwd);
    return {
        cleared: cleared || deletedGlobalSessions > 0,
        sessions: await listSessions(resolvedCwd),
    };
}
async function readProjectNotesDocument(cwd, config) {
    const resolvedCwd = path.resolve(cwd);
    const filePath = resolveProjectNotesPath(resolvedCwd, config.projectNotesPath);
    try {
        const content = await fs.readFile(filePath, "utf8");
        return {
            path: filePath,
            content,
            exists: true,
            includeInPrompt: config.includeProjectNotes !== false,
            isCustomPath: Boolean(config.projectNotesPath),
        };
    }
    catch {
        return {
            path: filePath,
            content: "",
            exists: false,
            includeInPrompt: config.includeProjectNotes !== false,
            isCustomPath: Boolean(config.projectNotesPath),
        };
    }
}
async function saveProjectNotesDocument(cwd, content, includeInPrompt) {
    const resolvedCwd = path.resolve(cwd);
    const currentConfig = await loadGradientCodeConfig(resolvedCwd);
    const nextConfig = {
        ...currentConfig,
        includeProjectNotes: includeInPrompt,
    };
    const filePath = resolveProjectNotesPath(resolvedCwd, currentConfig.projectNotesPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, String(content ?? ""), "utf8");
    await saveGradientCodeConfig(resolvedCwd, nextConfig);
    return readProjectNotesDocument(resolvedCwd, nextConfig);
}
async function openProjectNotesFile(cwd) {
    const resolvedCwd = path.resolve(cwd);
    const config = await loadGradientCodeConfig(resolvedCwd);
    const filePath = resolveProjectNotesPath(resolvedCwd, config.projectNotesPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fs.open(filePath, "a");
    await handle.close();
    const error = await shell.openPath(filePath);
    return {
        ok: error === "",
        error: error || null,
        path: filePath,
    };
}
function emitRunProgress(progress) {
    sendEvent({
        type: "run-progress",
        ...progress,
    });
}
function createApprovalTool(approveAll, runId) {
    return {
        name: "__approval__",
        description: "Internal tool for asking the user whether a sensitive action is allowed.",
        inputSchema: {
            type: "object",
            properties: {
                toolName: { type: "string" },
                summary: { type: "string" },
            },
        },
        permissionLevel: "execute",
        async execute(inputArgs) {
            if (approveAll) {
                return { ok: true, toolName: this.name, content: "approved" };
            }
            const request = describeApprovalRequest(runId, String(inputArgs.toolName ?? "tool"), String(inputArgs.summary ?? ""));
            if (approvalRulesThisRun.has(request.fingerprint)) {
                sendEvent({
                    type: "approval-auto-resolved",
                    ...request,
                    scope: "similar-this-run",
                });
                return { ok: true, toolName: this.name, content: "approved" };
            }
            sendEvent({
                type: "approval-request",
                ...request,
            });
            const approved = await new Promise((resolve) => {
                pendingApprovals.set(request.requestId, { resolve, request });
            });
            return { ok: true, toolName: this.name, content: approved ? "approved" : "denied" };
        },
    };
}
async function getBootstrapPayload(cwd) {
    const resolvedCwd = path.resolve(cwd);
    const stats = await fs.stat(resolvedCwd).catch(() => null);
    if (!stats || !stats.isDirectory()) {
        throw new Error(`Workspace directory not found: ${resolvedCwd}`);
    }
    await maybeLoadEnv(resolvedCwd);
    const config = await loadGradientCodeConfig(resolvedCwd);
    return {
        cwd: resolvedCwd,
        config,
        sessions: await listSessions(resolvedCwd),
        hasApiKey: Boolean(process.env.MODEL_ACCESS_KEY),
        projectNotes: await readProjectNotesDocument(resolvedCwd, config),
        modelOptions: AVAILABLE_GRADIENT_MODELS,
    };
}
async function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1500,
        height: 980,
        minWidth: 1100,
        minHeight: 760,
        backgroundColor: "#e9e4d8",
        title: "Gradient Code",
        icon: appIconPath,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: false,
            nodeIntegration: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) {
            void shell.openExternal(url);
        }
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const currentUrl = mainWindow?.webContents.getURL();
        if (url === currentUrl) {
            return;
        }
        event.preventDefault();
        if (isSafeExternalUrl(url)) {
            void shell.openExternal(url);
        }
    });
    await mainWindow.loadFile(path.resolve(__dirname, "../src/renderer/index.html"));
}
ipcMain.handle("desktop:get-bootstrap", async (_event, cwd) => {
    return getBootstrapPayload(cwd ?? process.cwd());
});
ipcMain.handle("desktop:choose-workspace", async (_event, cwd) => {
    const defaultPath = path.resolve(cwd ?? process.cwd());
    const dialogOptions = {
        title: "Choose Workspace",
        defaultPath,
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "Select Workspace",
    };
    const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }
    return path.resolve(result.filePaths[0]);
});
ipcMain.handle("desktop:list-sessions", async (_event, cwd) => {
    return listSessions(path.resolve(cwd));
});
ipcMain.handle("desktop:load-session", async (_event, cwd, sessionId) => {
    return loadSession(path.resolve(cwd), sessionId);
});
ipcMain.handle("desktop:delete-session", async (_event, cwd, sessionId) => {
    const resolvedCwd = path.resolve(cwd);
    const deleted = await deleteSession(resolvedCwd, sessionId);
    return {
        deleted,
        sessions: await listSessions(resolvedCwd),
    };
});
ipcMain.handle("desktop:save-config", async (_event, cwd, config) => {
    const resolvedCwd = path.resolve(cwd);
    const existingConfig = await loadGradientCodeConfig(resolvedCwd);
    return saveGradientCodeConfig(resolvedCwd, {
        ...existingConfig,
        ...config,
    });
});
ipcMain.handle("desktop:list-workspace-tree", async (_event, cwd, relativePath) => {
    return listWorkspaceDirectory(path.resolve(cwd), relativePath ?? "");
});
ipcMain.handle("desktop:read-workspace-file", async (_event, cwd, relativePath) => {
    return readWorkspaceFilePreview(path.resolve(cwd), relativePath);
});
ipcMain.handle("desktop:open-workspace-path", async (_event, cwd, relativePath) => {
    const absolutePath = resolveWorkspacePath(path.resolve(cwd), relativePath);
    const error = await shell.openPath(absolutePath);
    return {
        ok: error === "",
        error: error || null,
    };
});
ipcMain.handle("desktop:open-history-folder", async (_event, cwd) => {
    return openHistoryFolder(cwd);
});
ipcMain.handle("desktop:clear-workspace-history", async (_event, cwd) => {
    return clearWorkspaceHistory(cwd);
});
ipcMain.handle("desktop:save-project-notes", async (_event, cwd, payload) => {
    return saveProjectNotesDocument(path.resolve(cwd), String(payload?.content ?? ""), payload?.includeInPrompt !== false);
});
ipcMain.handle("desktop:open-project-notes", async (_event, cwd) => {
    return openProjectNotesFile(cwd);
});
ipcMain.handle("desktop:respond-approval", async (_event, requestId, response) => {
    const decision = typeof response === "boolean"
        ? response
            ? "approve-once"
            : "deny"
        : response?.decision === "approve-similar-run"
            ? "approve-similar-run"
            : response?.decision === "deny"
                ? "deny"
                : "approve-once";
    const approved = decision !== "deny";
    sendEvent({
        type: "debug-log",
        message: `desktop:respond-approval received requestId=${requestId} decision=${decision}`,
    });
    const pending = pendingApprovals.get(requestId);
    if (pending) {
        if (decision === "approve-similar-run") {
            approvalRulesThisRun.set(pending.request.fingerprint, pending.request);
        }
        pending.resolve(approved);
        pendingApprovals.delete(requestId);
        sendEvent({
            type: "debug-log",
            message: `desktop:respond-approval resolved requestId=${requestId} decision=${decision}`,
        });
        return { ok: true, decision };
    }
    sendEvent({
        type: "debug-log",
        message: `desktop:respond-approval missing requestId=${requestId}`,
    });
    return { ok: false, decision };
});
ipcMain.handle("desktop:cancel-run", async () => {
    if (!activeRunAbortController) {
        return { ok: false, cancelled: false };
    }
    sendEvent({
        type: "debug-log",
        message: "desktop:cancel-run received",
    });
    activeRunAbortController.abort(new Error("Run cancelled."));
    for (const [requestId, pending] of pendingApprovals.entries()) {
        pending.resolve(false);
        pendingApprovals.delete(requestId);
        sendEvent({
            type: "debug-log",
            message: `desktop:cancel-run released approval requestId=${requestId}`,
        });
    }
    approvalRulesThisRun.clear();
    return { ok: true, cancelled: true };
});
ipcMain.handle("desktop:start-run", async (_event, payload) => {
    if (activeRun) {
        throw new Error("A run is already in progress.");
    }
    activeRun = true;
    activeRunAbortController = new AbortController();
    const cwd = path.resolve(payload.cwd);
    const runId = makeRunId();
    let progress = null;
    sendEvent({
        type: "debug-log",
        message: `desktop:start-run received cwd=${cwd} model=${String(payload.model ?? "")} promptLength=${payload.prompt.length}`,
    });
    try {
        await maybeLoadEnv(cwd);
        const stats = await fs.stat(cwd).catch(() => null);
        if (!stats || !stats.isDirectory()) {
            throw new Error(`Workspace directory not found: ${cwd}`);
        }
        const fileConfig = await loadGradientCodeConfig(cwd);
        const model = normalizeModelName(payload.model ?? fileConfig.model ?? process.env.GRADIENT_MODEL ?? "kimi-k2.5");
        const approveAll = payload.approveAll ?? fileConfig.approveAll ?? false;
        const store = payload.store ?? fileConfig.storeResponses ?? true;
        const previewWrites = payload.previewWrites ?? fileConfig.previewEdits ?? true;
        const maxTurns = payload.maxTurns ?? fileConfig.maxTurns ?? 12;
        const preset = payload.preset ?? fileConfig.preset ?? "default";
        const providerTimeoutMs = payload.providerTimeoutMs ?? fileConfig.providerTimeoutMs ?? 60_000;
        const toolTimeoutMs = payload.toolTimeoutMs ?? fileConfig.toolTimeoutMs ?? 45_000;
        const retryCount = payload.retryCount ?? fileConfig.retryCount ?? 2;
        const profile = resolveModelCapabilityProfile(model);
        sendEvent({
            type: "debug-log",
            message: `Resolved config model=${model} retryCount=${retryCount} providerTimeoutMs=${providerTimeoutMs} toolTimeoutMs=${toolTimeoutMs}`,
        });
        const resumed = payload.branchSessionId
            ? await loadSession(cwd, payload.branchSessionId)
            : payload.sessionId
                ? await loadSession(cwd, payload.sessionId)
                : payload.resumeLast
                    ? await loadLatestSession(cwd)
                    : null;
        const threadIndex = countExistingThreads(resumed) + 1;
        progress = {
            runId,
            threadIndex,
            maxTurns,
            completedTurns: 0,
            toolCalls: 0,
            commandCalls: 0,
            phase: "starting",
        };
        const apiKey = process.env.MODEL_ACCESS_KEY;
        if (!apiKey) {
            throw new Error("Missing MODEL_ACCESS_KEY. Add it to your environment or .env file.");
        }
        const provider = new GradientResponsesClient({
            apiKey,
            baseUrl: fileConfig.baseUrl ?? process.env.GRADIENT_BASE_URL,
            retryCount,
            onDebug: (message) => {
                sendEvent({
                    type: "debug-log",
                    message,
                });
            },
        });
        approvalRulesThisRun.clear();
        sendEvent({
            type: "debug-log",
            message: `Provider initialized baseUrl=${String(fileConfig.baseUrl ?? process.env.GRADIENT_BASE_URL ?? "default")} resumed=${String(Boolean(resumed))}`,
        });
        const toolRegistry = new ToolRegistry([...getDefaultTools(), createApprovalTool(approveAll, runId)]);
        const projectNotes = await loadProjectNotes(cwd, fileConfig);
        const systemPrompt = buildAgentSystemPrompt({
            cwd,
            profile,
            preset,
            projectNotes,
        });
        sendEvent({
            type: "run-started",
            runId,
            threadIndex,
            cwd,
            model,
            prompt: payload.prompt,
            maxTurns,
            resumedSessionId: resumed?.id ?? null,
        });
        emitRunProgress(progress);
        const result = await runAgent({
            model,
            cwd,
            userPrompt: payload.prompt,
            systemPrompt,
            storeResponses: store,
            previewEdits: previewWrites,
            maxTurns,
            initialMessages: resumed?.messages,
            initialEvents: resumed?.events,
            sessionId: payload.branchSessionId ? undefined : resumed?.id,
            toolTimeoutMs,
            providerTimeoutMs,
            preset,
            abortSignal: activeRunAbortController.signal,
            runId,
        }, {
            provider,
            toolRegistry,
            onTextDelta: (chunk) => {
                sendEvent({ type: "assistant-delta", runId, chunk });
            },
            onAssistantTurnComplete: () => {
                sendEvent({ type: "assistant-complete", runId });
            },
            onTurnComplete: (turn) => {
                if (!progress) {
                    return;
                }
                progress.completedTurns = turn.turnIndex;
                progress.phase = turn.toolCalls.length > 0 ? "running-tools" : "responding";
                progress.activeToolName = turn.toolCalls[0]?.name;
                progress.usage = mergeUsage(progress.usage, turn.usage);
                emitRunProgress(progress);
            },
            onToolCall: (toolCall) => {
                if (!progress) {
                    return;
                }
                progress.toolCalls += 1;
                if (isCommandToolName(toolCall.name)) {
                    progress.commandCalls += 1;
                }
                progress.phase = "tool-call";
                progress.activeToolName = toolCall.name;
                sendEvent({ type: "tool-call", runId, toolCall });
                emitRunProgress(progress);
            },
            onToolResult: (toolCall, result) => {
                if (!progress) {
                    return;
                }
                progress.phase = result.ok ? "tool-result" : "tool-error";
                progress.activeToolName = toolCall.name;
                sendEvent({
                    type: "tool-result",
                    runId,
                    toolCall,
                    result,
                    summary: summarizeToolResult(result),
                });
                emitRunProgress(progress);
            },
        });
        sendEvent({
            type: "debug-log",
            message: `runAgent resolved sessionId=${result.sessionId} finalTextLength=${result.finalText.length}`,
        });
        const createdAt = payload.branchSessionId ? new Date().toISOString() : resumed?.createdAt ?? new Date().toISOString();
        const sessionState = {
            id: result.sessionId,
            cwd,
            model,
            systemPrompt,
            messages: result.messages,
            events: result.events,
            createdAt,
            updatedAt: new Date().toISOString(),
        };
        const sessionPath = store ? await saveSession(sessionState) : null;
        const transcriptPath = store ? await writeTranscript(cwd, result.events) : null;
        const sessions = await listSessions(cwd);
        if (progress) {
            progress.phase = "completed";
            progress.usage = mergeUsage(progress.usage, result.usage);
            emitRunProgress(progress);
        }
        sendEvent({
            type: "run-complete",
            runId,
            threadIndex,
            sessionId: store ? result.sessionId : null,
            sessionPath,
            transcriptPath,
            finalText: result.finalText,
            usage: result.usage,
            events: result.events,
            sessions,
        });
        return {
            ok: true,
            sessionId: result.sessionId,
            sessionPath,
            transcriptPath,
        };
    }
    catch (error) {
        const isCancelled = activeRunAbortController?.signal.aborted ||
            (error instanceof Error && (error.name === "AbortError" || error.message === "Run cancelled."));
        if (isCancelled) {
            if (progress) {
                progress.phase = "cancelled";
                emitRunProgress(progress);
            }
            sendEvent({
                type: "run-cancelled",
                runId,
                message: "Run cancelled.",
            });
            return {
                ok: false,
                cancelled: true,
            };
        }
        if (progress) {
            progress.phase = "error";
            emitRunProgress(progress);
        }
        sendEvent({
            type: "run-error",
            runId,
            message: error instanceof Error ? error.message : String(error),
        });
        sendEvent({
            type: "debug-log",
            message: `run-error ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        });
        throw error;
    }
    finally {
        activeRun = false;
        activeRunAbortController = null;
        approvalRulesThisRun.clear();
    }
});
app.whenReady().then(async () => {
    try {
        await fs.access(appIconPath);
        if (process.platform === "darwin" && app.dock) {
            app.dock.setIcon(nativeImage.createFromPath(appIconPath));
        }
    }
    catch {
        // Ignore missing icon file.
    }
    await createMainWindow();
    app.on("activate", async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await createMainWindow();
        }
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
//# sourceMappingURL=main.js.map