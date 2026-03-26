import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
const PRESET_INSTRUCTIONS = {
    default: [
        "Be moderately verbose by default: explain what you think is happening, what you are checking, what you found, and what you will do next.",
        "Use short running updates during multi-step work so the user can follow the investigation without waiting for the final answer.",
        "Before using a tool or making an edit, briefly tell the user what you are about to do and why unless the user asked for maximum brevity.",
    ],
    research: [
        "When the task depends on external or recent information, use web_search first and fetch_url for source follow-up.",
        "Cite concrete source URLs in your final answer when using web research.",
        "Summarize what you are checking before each research step so the user can follow the investigation.",
    ],
    plan: [
        "Produce phased plans with milestones, risks, dependencies, and validation steps.",
        "Use git-aware tools when available to ground the plan in current repo state and recent changes.",
        "Explain why each phase exists and what information you are gathering before planning further.",
    ],
    review: [
        "Prioritize bugs, regressions, security risks, and missing tests over stylistic commentary.",
        "Use git_changed_files before broad review claims, then use git_changed_file_summaries or targeted git_diff calls to inspect the highest-risk files.",
        "Use estimate_test_impact to identify likely affected tests, missing coverage, and the most relevant validation commands.",
        "If git-aware tools report that this workspace is not a git repository, treat that as informational, say so briefly, and continue the review by inspecting files directly.",
        "Briefly narrate the review approach before inspecting files or diffs.",
        "Present review findings first. Each finding should include a severity tag like [P1], [P2], or [P3], the affected file and line when known, the concrete risk, and why it matters.",
        "If no findings are discovered, say 'No findings.' and then note any residual risks or testing gaps.",
    ],
    implement: [
        "Move from inspection to implementation decisively once you have enough context.",
        "Prefer focused edits and validate changed behavior when practical.",
        "Before editing, briefly explain the intended change and why it should solve the problem.",
    ],
};
export class ToolRegistry {
    toolsByName;
    constructor(tools) {
        this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    }
    get(name) {
        return this.toolsByName.get(name);
    }
    definitions() {
        return [...this.toolsByName.values()].map(({ execute: _execute, ...tool }) => tool);
    }
    all() {
        return [...this.toolsByName.values()];
    }
}
export class SandboxPolicy {
    destructivePatterns = [
        /\brm\s+-rf\b/i,
        /\bgit\s+reset\s+--hard\b/i,
        /\bgit\s+clean\s+-fd\b/i,
        /\bsudo\b/i,
        /\bmkfs(\.| )/i,
        /\bdd\s+if=/i,
        /\bshutdown\b/i,
        /\breboot\b/i,
        /\bpoweroff\b/i,
        /\bdiskutil\s+erase/i,
        /:\(\)\s*\{\s*:\|:\s*&\s*\};:/,
    ];
    decide(tool, input) {
        const permissionLevel = tool.permissionLevel ?? "read";
        if (permissionLevel === "destructive") {
            return {
                allowed: false,
                reason: "Tool is classified as destructive and requires explicit policy approval.",
            };
        }
        if (tool.name === "run_command" || tool.name === "start_command_session") {
            const command = String(input.command ?? "");
            if (this.destructivePatterns.some((pattern) => pattern.test(command))) {
                return {
                    allowed: false,
                    reason: `Blocked destructive command: ${command}`,
                };
            }
        }
        return { allowed: true };
    }
}
function timestamp() {
    return new Date().toISOString();
}
function gradientCodeDir(cwd) {
    return path.join(cwd, ".gradient-code");
}
function globalGradientCodeDir() {
    return path.join(os.homedir(), ".gradient-code");
}
function globalSessionsDir() {
    return path.join(globalGradientCodeDir(), "sessions");
}
function knownWorkspacesPath() {
    return path.join(globalGradientCodeDir(), "workspaces.json");
}
export function resolveProjectNotesPath(cwd, customPath) {
    return customPath ? path.resolve(cwd, customPath) : path.join(gradientCodeDir(cwd), "project-notes.md");
}
export async function loadProjectNotes(cwd, config) {
    if (config?.includeProjectNotes === false) {
        return null;
    }
    const filePath = resolveProjectNotesPath(cwd, config?.projectNotesPath);
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const trimmed = raw.trim();
        return trimmed ? trimmed : null;
    }
    catch {
        return null;
    }
}
export function buildAgentSystemPrompt(input) {
    const preset = input.preset ?? "default";
    const lines = [
        "You are Gradient Code, a local coding assistant running through application-managed tools.",
        "",
        "Working style:",
        "Inspect the workspace before proposing changes or commands.",
        "Use tools when they reduce guesswork.",
        "If a tool fails, recover by inspecting the error and trying a smaller next step.",
        "",
        "Communication contract:",
        "Keep the user oriented while you work. Do not go silent through long tool sequences.",
        "Use a simple running commentary: what you are checking, why it matters, what you found, and what you will do next.",
        "Before each meaningful tool call, give a short explanation of what you are checking or changing and why.",
        "After meaningful tool results, briefly summarize the takeaway before moving on.",
        "During multi-step work, give concise progress updates rather than waiting until the very end.",
        "When you change your hypothesis or discover a blocker, say so explicitly.",
        "Keep these updates concrete and useful; avoid filler and repetition.",
        "",
        "Task handling:",
        "When the user asks for a plan, inspect the repo first and then return a concrete step-by-step implementation plan.",
        "When the user asks for a code review, focus first on bugs, regressions, risks, and missing tests before summaries.",
        "For reviews, inspect changed files or relevant files before making claims.",
        "For reviews, prefer a findings-first format with explicit severity, evidence, likely impact, and missing-test callouts.",
        "For plans, explain phases, milestones, and key risks.",
        "",
        "Tooling guidance:",
        "Prefer get_cwd, list_files, and git_status early when orienting yourself in a repository.",
        "For JS/TS codebases, prefer find_symbol, find_references, list_exports, and list_imports before broad text searches when symbol-level context matters.",
        "Prefer search_text before broad assumptions.",
        "Use web_search and fetch_url when the user asks for web research, recent information, or external references.",
        "Use git_diff and git_recent_commits when the task depends on recent code changes or git-aware planning.",
        "Use git_changed_files and git_changed_file_summaries to review changed files efficiently before diving into full diffs.",
        "Use estimate_test_impact when a review, refactor, or bug fix may affect tests or validation strategy.",
        "If a git-aware tool reports that the workspace is not a git repository, treat that as an informational limitation and continue with file-based inspection tools.",
        "Prefer read_file before making claims about file contents.",
        "Use ast_edit for JS/TS symbol renames, import updates, or declaration-targeted edits when it is a better fit than raw patching.",
        "Use apply_patch for focused edits when possible.",
        "Use write_file when replacing or creating a full file is simpler.",
        "Use run_command only when needed, and keep commands scoped to the workspace.",
        "Do not ask for tools by any name except the tools provided to you.",
        "",
        "Final answer:",
        "When you are done, provide a clear and slightly more detailed final answer unless the user asked for brevity.",
        `Prompt preset: ${preset}`,
        ...PRESET_INSTRUCTIONS[preset],
        `Model profile: ${input.profile.model}`,
        ...input.profile.promptHints,
        `Current workspace: ${input.cwd}`,
    ];
    if (input.projectNotes?.trim()) {
        lines.push("Project notes:");
        lines.push(input.projectNotes.trim());
    }
    return lines.join("\n");
}
function buildTurnSystemPrompt(basePrompt, options) {
    const reminders = [];
    if (options.turnIndex === 0) {
        reminders.push("Turn-specific reminder: if you are about to use tools, first give the user a short explanation of what you are checking and why.");
    }
    if (options.afterToolResults) {
        reminders.push("Turn-specific reminder: start this turn with a brief progress update about what you learned from the last tool results and what you will do next before making more tool calls.");
    }
    if (reminders.length === 0) {
        return basePrompt;
    }
    return `${basePrompt}\n\n${reminders.join("\n")}`;
}
function sessionsDir(cwd) {
    return path.join(gradientCodeDir(cwd), "sessions");
}
function normalizeWorkspacePath(cwd) {
    return path.resolve(cwd);
}
function sameWorkspace(left, right) {
    return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}
function sessionFilePath(directory, sessionId) {
    return path.join(directory, `${sessionId}.json`);
}
async function readSessionState(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function writeSessionState(filePath, state) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
function summarizeSession(state) {
    const lastUserEvent = [...state.events].reverse().find((event) => event.type === "user");
    return {
        id: state.id,
        cwd: state.cwd,
        model: state.model,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        lastUserPrompt: lastUserEvent?.type === "user" ? lastUserEvent.text : "",
    };
}
function compareIsoTimestampDescending(left, right) {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
    }
    return right.localeCompare(left);
}
async function listSessionStatesInDirectory(directory) {
    try {
        const entries = (await fs.readdir(directory))
            .filter((entry) => entry.endsWith(".json"))
            .sort()
            .reverse();
        const states = await Promise.all(entries.map((entry) => readSessionState(path.join(directory, entry))));
        return states.filter((state) => Boolean(state));
    }
    catch {
        return [];
    }
}
async function readKnownWorkspaceRegistry() {
    try {
        const raw = await fs.readFile(knownWorkspacesPath(), "utf8");
        const parsed = JSON.parse(raw);
        const workspaces = Array.isArray(parsed.workspaces)
            ? parsed.workspaces
                .map((workspace) => normalizeWorkspacePath(String(workspace)))
                .filter(Boolean)
            : [];
        return {
            workspaces: [...new Set(workspaces)].sort((left, right) => left.localeCompare(right)),
            legacyDiscoveryCompleted: parsed.legacyDiscoveryCompleted === true,
        };
    }
    catch {
        return {
            workspaces: [],
            legacyDiscoveryCompleted: false,
        };
    }
}
async function writeKnownWorkspaceRegistry(registry) {
    await fs.mkdir(globalGradientCodeDir(), { recursive: true });
    await fs.writeFile(knownWorkspacesPath(), `${JSON.stringify({
        workspaces: [...new Set(registry.workspaces.map((workspace) => normalizeWorkspacePath(workspace)))].sort((left, right) => left.localeCompare(right)),
        legacyDiscoveryCompleted: registry.legacyDiscoveryCompleted === true,
    }, null, 2)}\n`, "utf8");
}
async function directoryHasSessionFiles(directory) {
    try {
        const entries = await fs.readdir(directory);
        return entries.some((entry) => entry.endsWith(".json"));
    }
    catch {
        return false;
    }
}
async function discoverLegacyWorkspaces(rootDir) {
    const ignoredNames = new Set([
        ".git",
        ".gradient-code",
        ".Trash",
        "Applications",
        "Library",
        "Movies",
        "Music",
        "Pictures",
        "Public",
        "node_modules",
    ]);
    const maxDepth = 6;
    const maxDirectories = 4000;
    const results = new Set();
    const queue = [{ directory: rootDir, depth: 0 }];
    let visitedDirectories = 0;
    while (queue.length > 0 && visitedDirectories < maxDirectories) {
        const current = queue.pop();
        if (!current) {
            continue;
        }
        visitedDirectories += 1;
        const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
        const hasLocalSessions = await directoryHasSessionFiles(path.join(current.directory, ".gradient-code", "sessions"));
        if (hasLocalSessions) {
            results.add(normalizeWorkspacePath(current.directory));
            continue;
        }
        if (current.depth >= maxDepth) {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                continue;
            }
            if (ignoredNames.has(entry.name)) {
                continue;
            }
            queue.push({
                directory: path.join(current.directory, entry.name),
                depth: current.depth + 1,
            });
        }
    }
    return [...results].sort((left, right) => left.localeCompare(right));
}
async function ensureKnownWorkspaceRegistry(cwd) {
    const registry = await readKnownWorkspaceRegistry();
    const workspaces = new Set(registry.workspaces.map((workspace) => normalizeWorkspacePath(workspace)));
    if (cwd) {
        workspaces.add(normalizeWorkspacePath(cwd));
    }
    let discoveredNow = false;
    if (!registry.legacyDiscoveryCompleted) {
        const discovered = await discoverLegacyWorkspaces(os.homedir());
        for (const workspace of discovered) {
            workspaces.add(workspace);
        }
        discoveredNow = true;
    }
    const nextRegistry = {
        workspaces: [...workspaces].sort((left, right) => left.localeCompare(right)),
        legacyDiscoveryCompleted: registry.legacyDiscoveryCompleted || discoveredNow,
    };
    if (nextRegistry.legacyDiscoveryCompleted !== registry.legacyDiscoveryCompleted ||
        nextRegistry.workspaces.length !== registry.workspaces.length ||
        nextRegistry.workspaces.some((workspace, index) => workspace !== registry.workspaces[index])) {
        await writeKnownWorkspaceRegistry(nextRegistry);
    }
    return {
        workspaces: nextRegistry.workspaces,
        discoveredNow,
    };
}
async function syncWorkspaceSessionsToGlobal(cwd) {
    const resolvedCwd = normalizeWorkspacePath(cwd);
    const states = await listSessionStatesInDirectory(sessionsDir(resolvedCwd));
    if (states.length === 0) {
        return;
    }
    await fs.mkdir(globalSessionsDir(), { recursive: true });
    await Promise.all(states.map(async (state) => {
        const normalizedState = {
            ...state,
            cwd: normalizeWorkspacePath(state.cwd || resolvedCwd),
        };
        await writeSessionState(sessionFilePath(globalSessionsDir(), normalizedState.id), normalizedState);
    }));
}
async function ensureGlobalSessionStore(cwd) {
    const registry = await ensureKnownWorkspaceRegistry(cwd);
    if (cwd) {
        await syncWorkspaceSessionsToGlobal(cwd);
    }
    if (registry.discoveredNow) {
        const additionalWorkspaces = cwd
            ? registry.workspaces.filter((workspace) => !sameWorkspace(workspace, cwd))
            : registry.workspaces;
        await Promise.all(additionalWorkspaces.map((workspace) => syncWorkspaceSessionsToGlobal(workspace)));
    }
}
function configPath(cwd) {
    return path.join(cwd, "gradient-code.config.json");
}
function makeSessionId() {
    return `session-${new Date().toISOString().replaceAll(":", "-")}`;
}
function makeRunId() {
    return `run-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(36).slice(2, 8)}`;
}
function mergeTokenUsage(existing, incoming) {
    if (!existing && !incoming) {
        return undefined;
    }
    const next = {
        inputTokens: (existing?.inputTokens ?? 0) + (incoming?.inputTokens ?? 0),
        outputTokens: (existing?.outputTokens ?? 0) + (incoming?.outputTokens ?? 0),
    };
    if (typeof existing?.totalTokens === "number" || typeof incoming?.totalTokens === "number") {
        next.totalTokens = (existing?.totalTokens ?? 0) + (incoming?.totalTokens ?? 0);
    }
    else if (typeof next.inputTokens === "number" && typeof next.outputTokens === "number") {
        next.totalTokens = next.inputTokens + next.outputTokens;
    }
    return next;
}
function truncateForModel(value, maxLength = 4000) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} characters]`;
}
function formatToolResult(result) {
    if (result.ok) {
        const summaryLines = [];
        if (typeof result.metadata?.path === "string") {
            summaryLines.push(`path=${result.metadata.path}`);
        }
        if (typeof result.metadata?.count === "number") {
            summaryLines.push(`count=${String(result.metadata.count)}`);
        }
        if (typeof result.metadata?.returned === "number") {
            summaryLines.push(`returned=${String(result.metadata.returned)}`);
        }
        if (typeof result.metadata?.truncated === "boolean") {
            summaryLines.push(`truncated=${String(result.metadata.truncated)}`);
        }
        if (typeof result.metadata?.command === "string") {
            summaryLines.push(`command=${result.metadata.command}`);
        }
        const content = truncateForModel(result.content);
        return summaryLines.length > 0 ? `${summaryLines.join("\n")}\n\n${content}` : content;
    }
    return truncateForModel(JSON.stringify(result, null, 2), 2500);
}
function buildFinalFallback(events, cwd) {
    const recentToolResults = [...events]
        .reverse()
        .filter((event) => event.type === "tool_result")
        .slice(0, 4)
        .reverse();
    if (recentToolResults.length === 0) {
        return `I inspected ${cwd}, but the model finished without returning a final message. Please try the request again.`;
    }
    const lines = recentToolResults.map((event) => {
        if (event.result.ok) {
            const content = event.result.content.trim();
            return `${event.toolName}: ${content || "completed successfully"}`;
        }
        return `${event.toolName}: ${event.result.error.code} - ${event.result.error.message}`;
    });
    return [
        `I inspected ${cwd}, but the model finished without a final explanation.`,
        "Recent tool results:",
        ...lines.map((line) => `- ${line}`),
    ].join("\n");
}
function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }
    const reason = signal.reason instanceof Error ? signal.reason.message : "Run cancelled.";
    const error = new Error(reason);
    error.name = "AbortError";
    throw error;
}
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function withTimeout(promise, timeoutMs, label) {
    if (timeoutMs <= 0) {
        return promise;
    }
    let timer;
    return Promise.race([
        promise.finally(() => {
            if (timer) {
                clearTimeout(timer);
            }
        }),
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`${label} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }),
    ]);
}
function validateValue(value, schema, pathLabel) {
    const errors = [];
    if (schema.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            errors.push(`${pathLabel} must be an object`);
            return errors;
        }
        const record = value;
        for (const key of schema.required ?? []) {
            if (!(key in record)) {
                errors.push(`${pathLabel}.${key} is required`);
            }
        }
        for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
            if (key in record) {
                errors.push(...validateValue(record[key], propertySchema, `${pathLabel}.${key}`));
            }
        }
        return errors;
    }
    if (schema.type === "string" && typeof value !== "string") {
        errors.push(`${pathLabel} must be a string`);
    }
    if (schema.type === "array" && !Array.isArray(value)) {
        errors.push(`${pathLabel} must be an array`);
    }
    if (schema.type === "number" && typeof value !== "number") {
        errors.push(`${pathLabel} must be a number`);
    }
    if (schema.enum && !schema.enum.includes(String(value))) {
        errors.push(`${pathLabel} must be one of: ${schema.enum.join(", ")}`);
    }
    return errors;
}
function validateToolInvocation(tool, input) {
    const errors = validateValue(input, tool.inputSchema, tool.name);
    if (errors.length === 0) {
        return null;
    }
    return {
        ok: false,
        toolName: tool.name,
        error: {
            code: "INVALID_TOOL_INPUT",
            message: errors.join("; "),
        },
        metadata: {
            input,
        },
    };
}
export async function loadGradientCodeConfig(cwd) {
    try {
        const raw = await fs.readFile(configPath(cwd), "utf8");
        const parsed = JSON.parse(raw);
        return parsed ?? {};
    }
    catch {
        return {};
    }
}
export async function saveGradientCodeConfig(cwd, config) {
    const filePath = configPath(cwd);
    await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return filePath;
}
export async function loadSession(cwd, sessionId) {
    const resolvedCwd = normalizeWorkspacePath(cwd);
    const localState = await readSessionState(sessionFilePath(sessionsDir(resolvedCwd), sessionId));
    if (localState) {
        return {
            ...localState,
            cwd: normalizeWorkspacePath(localState.cwd || resolvedCwd),
        };
    }
    const globalState = await readSessionState(sessionFilePath(globalSessionsDir(), sessionId));
    if (!globalState) {
        return null;
    }
    return {
        ...globalState,
        cwd: normalizeWorkspacePath(globalState.cwd),
    };
}
export async function deleteSession(cwd, sessionId) {
    const resolvedCwd = normalizeWorkspacePath(cwd);
    let deleted = false;
    const localPath = sessionFilePath(sessionsDir(resolvedCwd), sessionId);
    const globalPath = sessionFilePath(globalSessionsDir(), sessionId);
    const globalState = await readSessionState(globalPath);
    await Promise.all([
        fs.unlink(localPath)
            .then(() => {
            deleted = true;
        })
            .catch(() => undefined),
        fs.unlink(globalPath)
            .then(() => {
            deleted = true;
        })
            .catch(() => undefined),
    ]);
    if (globalState?.cwd && !sameWorkspace(globalState.cwd, resolvedCwd)) {
        await fs.unlink(sessionFilePath(sessionsDir(globalState.cwd), sessionId))
            .then(() => {
            deleted = true;
        })
            .catch(() => undefined);
    }
    return deleted;
}
export async function loadLatestSession(cwd) {
    const states = await listSessionStatesInDirectory(sessionsDir(normalizeWorkspacePath(cwd)));
    const [latest] = states.sort((left, right) => compareIsoTimestampDescending(left.updatedAt, right.updatedAt));
    if (!latest) {
        return null;
    }
    return latest;
}
export async function listSessions(cwd) {
    await ensureGlobalSessionStore(cwd);
    const states = await listSessionStatesInDirectory(globalSessionsDir());
    return states
        .map((state) => summarizeSession({
        ...state,
        cwd: normalizeWorkspacePath(state.cwd),
    }))
        .sort((left, right) => compareIsoTimestampDescending(left.updatedAt, right.updatedAt));
}
export async function saveSession(state) {
    const normalizedState = {
        ...state,
        cwd: normalizeWorkspacePath(state.cwd),
    };
    const directory = sessionsDir(normalizedState.cwd);
    const filePath = sessionFilePath(directory, normalizedState.id);
    await ensureKnownWorkspaceRegistry(normalizedState.cwd);
    await writeSessionState(filePath, normalizedState);
    await writeSessionState(sessionFilePath(globalSessionsDir(), normalizedState.id), normalizedState);
    return filePath;
}
export async function deleteSessionsForWorkspace(cwd) {
    const resolvedCwd = normalizeWorkspacePath(cwd);
    const states = await listSessionStatesInDirectory(globalSessionsDir());
    const matching = states.filter((state) => sameWorkspace(state.cwd, resolvedCwd));
    if (matching.length === 0) {
        return 0;
    }
    await Promise.all(matching.map((state) => fs.unlink(sessionFilePath(globalSessionsDir(), state.id)).catch(() => undefined)));
    return matching.length;
}
export async function writeTranscript(cwd, events) {
    const logDir = gradientCodeDir(cwd);
    await fs.mkdir(logDir, { recursive: true });
    const filePath = path.join(logDir, `session-${new Date().toISOString().replaceAll(":", "-")}.json`);
    await fs.writeFile(filePath, JSON.stringify({ events }, null, 2), "utf8");
    return filePath;
}
export async function runAgent(options, dependencies) {
    const maxTurns = options.maxTurns ?? 12;
    const policy = new SandboxPolicy();
    const runId = options.runId ?? makeRunId();
    const messages = [...(options.initialMessages ?? []), { role: "user", content: options.userPrompt }];
    const events = [
        ...(options.initialEvents ?? []),
        { type: "user", text: options.userPrompt, timestamp: timestamp(), runId },
    ];
    const sessionId = options.sessionId ?? makeSessionId();
    let previousResponseId;
    let finalText = "";
    let completedWithToolCalls = false;
    let shouldNarrateFromPreviousTools = false;
    let usage;
    let completedTurns = 0;
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
        throwIfAborted(options.abortSignal);
        const request = {
            model: options.model,
            systemPrompt: buildTurnSystemPrompt(options.systemPrompt, {
                turnIndex,
                afterToolResults: shouldNarrateFromPreviousTools,
            }),
            messages,
            tools: dependencies.toolRegistry.definitions(),
            previousResponseId,
            store: options.storeResponses,
            abortSignal: options.abortSignal,
        };
        const turn = await (dependencies.provider.createTurnStream
            ? dependencies.provider.createTurnStream(request, {
                onTextDelta: (chunk) => {
                    dependencies.onTextDelta?.(chunk);
                },
            })
            : dependencies.provider.createTurn(request));
        previousResponseId = turn.id;
        throwIfAborted(options.abortSignal);
        usage = mergeTokenUsage(usage, turn.usage);
        if (turn.text) {
            finalText = turn.text;
            events.push({ type: "assistant", text: turn.text, timestamp: timestamp(), runId });
            dependencies.onAssistantTurnComplete?.();
        }
        const toolCalls = turn.outputs
            .filter((output) => output.type === "tool_call")
            .map((output) => ({
            callId: output.callId,
            name: output.name,
            arguments: output.arguments,
        }));
        dependencies.onTurnComplete?.({
            turnIndex: turnIndex + 1,
            maxTurns,
            toolCalls,
            usage,
        });
        completedTurns = turnIndex + 1;
        if (toolCalls.length === 0) {
            completedWithToolCalls = false;
            break;
        }
        completedWithToolCalls = true;
        shouldNarrateFromPreviousTools = true;
        messages.push({
            role: "assistant",
            content: turn.text,
            toolCalls,
        });
        for (const toolCall of toolCalls) {
            throwIfAborted(options.abortSignal);
            dependencies.onToolCall?.(toolCall);
            events.push({
                type: "tool_call",
                toolName: toolCall.name,
                callId: toolCall.callId,
                input: toolCall.arguments,
                timestamp: timestamp(),
                runId,
            });
            const tool = dependencies.toolRegistry.get(toolCall.name);
            if (!tool) {
                const missingResult = {
                    ok: false,
                    toolName: toolCall.name,
                    error: {
                        code: "UNKNOWN_TOOL",
                        message: `Tool not found: ${toolCall.name}`,
                    },
                };
                messages.push({
                    role: "tool",
                    toolName: toolCall.name,
                    callId: toolCall.callId,
                    content: JSON.stringify(missingResult, null, 2),
                    ok: false,
                });
                events.push({
                    type: "tool_result",
                    toolName: toolCall.name,
                    callId: toolCall.callId,
                    result: missingResult,
                    timestamp: timestamp(),
                    runId,
                });
                dependencies.onToolResult?.(toolCall, missingResult);
                continue;
            }
            const policyDecision = policy.decide(tool, toolCall.arguments);
            const validationResult = validateToolInvocation(tool, toolCall.arguments);
            const result = !policyDecision.allowed
                ? {
                    ok: false,
                    toolName: toolCall.name,
                    error: {
                        code: "POLICY_BLOCKED",
                        message: policyDecision.reason ?? "Tool call blocked by sandbox policy",
                    },
                }
                : validationResult
                    ? validationResult
                    : await withTimeout(tool.execute(toolCall.arguments, {
                        cwd: options.cwd,
                        previewEdits: options.previewEdits,
                        approve: async (toolName, summary) => {
                            throwIfAborted(options.abortSignal);
                            const approvalTool = dependencies.toolRegistry.get("__approval__");
                            if (!approvalTool) {
                                return false;
                            }
                            const approvalResult = await approvalTool.execute({ toolName, summary }, { cwd: options.cwd, previewEdits: options.previewEdits, approve: async () => false });
                            return approvalResult.ok && approvalResult.content === "approved";
                        },
                    }), options.toolTimeoutMs ?? 45_000, `Tool ${toolCall.name}`).catch((error) => ({
                        ok: false,
                        toolName: toolCall.name,
                        error: {
                            code: "TOOL_TIMEOUT",
                            message: error instanceof Error ? error.message : "Tool timed out",
                        },
                    }));
            messages.push({
                role: "tool",
                toolName: toolCall.name,
                callId: toolCall.callId,
                content: formatToolResult(result),
                ok: result.ok,
            });
            events.push({
                type: "tool_result",
                toolName: toolCall.name,
                callId: toolCall.callId,
                result,
                timestamp: timestamp(),
                runId,
            });
            dependencies.onToolResult?.(toolCall, result);
        }
    }
    if (!finalText && completedWithToolCalls) {
        throwIfAborted(options.abortSignal);
        const finalTurn = await dependencies.provider.createTurn({
            model: options.model,
            systemPrompt: `${options.systemPrompt}\nProvide a direct final response to the user now. Do not call tools.`,
            messages,
            tools: [],
            previousResponseId,
            store: options.storeResponses,
            abortSignal: options.abortSignal,
        });
        previousResponseId = finalTurn.id;
        usage = mergeTokenUsage(usage, finalTurn.usage);
        if (finalTurn.text) {
            finalText = finalTurn.text;
            messages.push({
                role: "assistant",
                content: finalTurn.text,
            });
            events.push({ type: "assistant", text: finalTurn.text, timestamp: timestamp(), runId });
            dependencies.onTextDelta?.(finalTurn.text);
            dependencies.onAssistantTurnComplete?.();
            dependencies.onTurnComplete?.({
                turnIndex: completedTurns + 1,
                maxTurns,
                toolCalls: [],
                usage,
            });
            completedTurns += 1;
        }
    }
    if (!finalText) {
        finalText = buildFinalFallback(events, options.cwd);
        messages.push({
            role: "assistant",
            content: finalText,
        });
        events.push({ type: "assistant", text: finalText, timestamp: timestamp(), runId });
        dependencies.onTextDelta?.(finalText);
        dependencies.onAssistantTurnComplete?.();
    }
    return {
        finalText,
        events,
        messages,
        sessionId,
        runId,
        usage,
    };
}
//# sourceMappingURL=index.js.map