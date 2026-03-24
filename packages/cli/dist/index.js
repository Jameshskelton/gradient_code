import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildAgentSystemPrompt, loadProjectNotes, ToolRegistry, loadGradientCodeConfig, loadLatestSession, loadSession, runAgent, saveGradientCodeConfig, saveSession, writeTranscript, } from "@gradient-code/core";
import { GradientResponsesClient } from "@gradient-code/provider-gradient";
import { resolveModelCapabilityProfile } from "@gradient-code/provider-gradient";
import { getDefaultTools } from "@gradient-code/tools";
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
        // Ignore missing .env files.
    }
}
function parseArgs(argv) {
    const options = {
        prompt: "",
    };
    const promptParts = [];
    for (let index = 0; index < argv.length; index += 1) {
        const part = argv[index];
        if (part === "--model") {
            options.model = argv[index + 1];
            index += 1;
            continue;
        }
        if (part === "--cwd") {
            options.cwd = argv[index + 1];
            index += 1;
            continue;
        }
        if (part === "--preset") {
            options.preset = argv[index + 1] ?? "default";
            index += 1;
            continue;
        }
        if (part === "--approve-all") {
            options.approveAll = true;
            continue;
        }
        if (part === "--no-store") {
            options.store = false;
            continue;
        }
        if (part === "--no-preview-writes") {
            options.previewWrites = false;
            continue;
        }
        if (part === "--max-turns") {
            options.maxTurns = Number.parseInt(argv[index + 1] ?? "", 10);
            index += 1;
            continue;
        }
        if (part === "--session") {
            options.sessionId = argv[index + 1];
            index += 1;
            continue;
        }
        if (part === "--resume-last") {
            options.resumeLast = true;
            continue;
        }
        if (part === "--save-config") {
            options.saveConfig = true;
            continue;
        }
        if (part === "--print-config") {
            options.printConfig = true;
            continue;
        }
        if (part === "--provider-timeout-ms") {
            options.providerTimeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
            index += 1;
            continue;
        }
        if (part === "--tool-timeout-ms") {
            options.toolTimeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
            index += 1;
            continue;
        }
        if (part === "--retry-count") {
            options.retryCount = Number.parseInt(argv[index + 1] ?? "", 10);
            index += 1;
            continue;
        }
        promptParts.push(part);
    }
    options.prompt = promptParts.join(" ").trim();
    return options;
}
async function promptForInput(label) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(label);
    rl.close();
    return answer.trim();
}
function resolveConfig(cliOptions, fileConfig) {
    return {
        cwd: path.resolve(cliOptions.cwd ?? process.cwd()),
        model: cliOptions.model ?? fileConfig.model ?? process.env.GRADIENT_MODEL ?? "kimi-k2.5",
        preset: cliOptions.preset ?? fileConfig.preset ?? "default",
        baseUrl: fileConfig.baseUrl ?? process.env.GRADIENT_BASE_URL,
        approveAll: cliOptions.approveAll ?? fileConfig.approveAll ?? false,
        store: cliOptions.store ?? fileConfig.storeResponses ?? true,
        previewWrites: cliOptions.previewWrites ?? fileConfig.previewEdits ?? true,
        maxTurns: cliOptions.maxTurns ?? fileConfig.maxTurns ?? 12,
        sessionId: cliOptions.sessionId ?? fileConfig.sessionId,
        prompt: cliOptions.prompt,
        saveConfig: cliOptions.saveConfig ?? false,
        printConfig: cliOptions.printConfig ?? false,
        resumeLast: cliOptions.resumeLast ?? false,
        providerTimeoutMs: cliOptions.providerTimeoutMs ?? fileConfig.providerTimeoutMs ?? 60_000,
        toolTimeoutMs: cliOptions.toolTimeoutMs ?? fileConfig.toolTimeoutMs ?? 45_000,
        retryCount: cliOptions.retryCount ?? fileConfig.retryCount ?? 2,
    };
}
function truncate(value, maxLength = 220) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 3)}...`;
}
function formatInput(inputArgs) {
    const entries = Object.entries(inputArgs);
    if (entries.length === 0) {
        return "no arguments";
    }
    return entries
        .map(([key, value]) => {
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}=${truncate(rendered, 120)}`;
    })
        .join(", ");
}
function summarizeToolResult(result) {
    if (!result.ok) {
        return `error ${result.error.code}: ${result.error.message}`;
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
        return `${returned}/${total} files: ${truncate(result.metadata.files.join(", "), 120)}`;
    }
    if (typeof result.metadata?.path === "string") {
        const changed = result.metadata?.changed === true ? "changed" : "ok";
        return `${changed}: ${result.metadata.path}`;
    }
    if (typeof result.metadata?.root === "string") {
        return `${String(result.metadata?.returned ?? result.metadata?.count ?? "")} entries from ${result.metadata.root}`;
    }
    if (typeof result.metadata?.command === "string") {
        return `exit ${String(result.metadata?.exitCode ?? 0)}: ${truncate(result.metadata.command, 120)}`;
    }
    return truncate(result.content, 160);
}
function renderSessionSummary(events, finalText) {
    console.log("");
    console.log("Session Summary");
    console.log("===============");
    const userEvent = events.find((event) => event.type === "user");
    if (userEvent) {
        console.log(`Prompt: ${userEvent.text}`);
    }
    const toolCalls = events.filter((event) => event.type === "tool_call");
    const toolResults = new Map(events
        .filter((event) => event.type === "tool_result")
        .map((event) => [event.callId, event]));
    if (toolCalls.length > 0) {
        console.log("");
        console.log("Tool Activity");
        console.log("-------------");
        for (const toolCall of toolCalls) {
            const resultEvent = toolResults.get(toolCall.callId);
            console.log(`- ${toolCall.toolName}: ${formatInput(toolCall.input)}`);
            if (resultEvent) {
                console.log(`  ${summarizeToolResult(resultEvent.result)}`);
            }
        }
    }
    if (finalText.trim()) {
        console.log("");
        console.log("Final Answer");
        console.log("------------");
        console.log(finalText.trim());
    }
}
function createApprovalTool(approveAll) {
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
            const rl = readline.createInterface({ input, output });
            const toolName = String(inputArgs.toolName ?? "tool");
            const summary = String(inputArgs.summary ?? "");
            console.log("");
            const answer = await rl.question(`Approve ${toolName}? ${summary} [y/N] `);
            rl.close();
            const approved = /^y(es)?$/i.test(answer.trim());
            return { ok: true, toolName: this.name, content: approved ? "approved" : "denied" };
        },
    };
}
function renderToolIntent(toolCall) {
    console.log("");
    console.log(`Tool> ${toolCall.name} ${formatInput(toolCall.arguments)}`);
}
function renderToolResult(toolCall, result) {
    console.log(`Tool< ${toolCall.name} ${summarizeToolResult(result)}`);
}
function startAssistantStream() {
    let started = false;
    return {
        onDelta(chunk) {
            if (!started) {
                process.stdout.write("\nAssistant> ");
                started = true;
            }
            process.stdout.write(chunk);
        },
        complete() {
            if (started) {
                process.stdout.write("\n");
            }
        },
    };
}
async function resolveSessionState(config) {
    const cwd = config.cwd;
    if (config.sessionId) {
        const state = await loadSession(cwd, config.sessionId);
        if (!state) {
            throw new Error(`Session not found: ${config.sessionId}`);
        }
        return {
            id: state.id,
            messages: state.messages,
            events: state.events,
            systemPrompt: state.systemPrompt,
        };
    }
    if (config.resumeLast) {
        const state = await loadLatestSession(cwd);
        if (!state) {
            return null;
        }
        return {
            id: state.id,
            messages: state.messages,
            events: state.events,
            systemPrompt: state.systemPrompt,
        };
    }
    return null;
}
async function main() {
    await maybeLoadEnv(process.cwd());
    const cliOptions = parseArgs(process.argv.slice(2));
    const cwdForConfig = path.resolve(cliOptions.cwd ?? process.cwd());
    const fileConfig = await loadGradientCodeConfig(cwdForConfig);
    const options = resolveConfig(cliOptions, fileConfig);
    if (options.printConfig) {
        console.log(JSON.stringify(options, null, 2));
        return;
    }
    const prompt = options.prompt || (await promptForInput("Prompt: "));
    if (!prompt) {
        throw new Error("Usage: gradient_code [--model MODEL] [--cwd PATH] [--approve-all] [--no-store] [--no-preview-writes] [--session ID] [--resume-last] [--max-turns N] \"your prompt\"");
    }
    const apiKey = process.env.MODEL_ACCESS_KEY;
    if (!apiKey) {
        throw new Error("Missing MODEL_ACCESS_KEY. Add it to your environment or .env file.");
    }
    if (options.saveConfig) {
        const filePath = await saveGradientCodeConfig(options.cwd, {
            model: options.model,
            preset: options.preset,
            baseUrl: options.baseUrl,
            approveAll: options.approveAll,
            storeResponses: options.store,
            previewEdits: options.previewWrites,
            maxTurns: options.maxTurns,
            sessionId: options.sessionId,
            providerTimeoutMs: options.providerTimeoutMs,
            toolTimeoutMs: options.toolTimeoutMs,
            retryCount: options.retryCount,
        });
        console.log(`Saved config: ${filePath}`);
    }
    const provider = new GradientResponsesClient({
        apiKey,
        baseUrl: options.baseUrl,
        retryCount: options.retryCount,
    });
    const toolRegistry = new ToolRegistry([...getDefaultTools(), createApprovalTool(options.approveAll)]);
    const resumed = await resolveSessionState(options);
    const profile = resolveModelCapabilityProfile(options.model);
    const projectNotes = await loadProjectNotes(options.cwd, fileConfig);
    const systemPrompt = resumed?.systemPrompt ??
        buildAgentSystemPrompt({
            cwd: options.cwd,
            profile,
            preset: options.preset,
            projectNotes,
        });
    const stream = startAssistantStream();
    console.log(`Model: ${options.model}`);
    console.log(`Preset: ${options.preset}`);
    console.log(`Workspace: ${options.cwd}`);
    if (resumed?.id) {
        console.log(`Session: ${resumed.id} (resumed)`);
    }
    const result = await runAgent({
        model: options.model,
        cwd: options.cwd,
        userPrompt: prompt,
        systemPrompt,
        preset: options.preset,
        storeResponses: options.store,
        previewEdits: options.previewWrites,
        maxTurns: options.maxTurns,
        initialMessages: resumed?.messages,
        initialEvents: resumed?.events,
        sessionId: resumed?.id,
        toolTimeoutMs: options.toolTimeoutMs,
        providerTimeoutMs: options.providerTimeoutMs,
    }, {
        provider,
        toolRegistry,
        onTextDelta: stream.onDelta,
        onAssistantTurnComplete: stream.complete,
        onToolCall: renderToolIntent,
        onToolResult: renderToolResult,
    });
    const sessionState = {
        id: result.sessionId,
        cwd: options.cwd,
        model: options.model,
        systemPrompt,
        messages: result.messages,
        events: result.events,
        createdAt: resumed ? timestampFromEvents(resumed.events) : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const sessionPath = await saveSession(sessionState);
    renderSessionSummary(result.events, result.finalText);
    console.log("");
    const transcriptPath = await writeTranscript(options.cwd, result.events);
    console.log(`Session File: ${sessionPath}`);
    console.log(`Transcript: ${transcriptPath}`);
}
function timestampFromEvents(events) {
    return events[0]?.timestamp ?? new Date().toISOString();
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map