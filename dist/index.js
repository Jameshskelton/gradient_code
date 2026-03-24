import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent, writeTranscript } from "@gradient-code/core";
import { GradientResponsesClient } from "@gradient-code/provider-gradient";
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
        model: process.env.GRADIENT_MODEL ?? "openai-gpt-oss-20b",
        cwd: process.cwd(),
        approveAll: false,
        store: true,
    };
    const promptParts = [];
    for (let index = 0; index < argv.length; index += 1) {
        const part = argv[index];
        if (part === "--model") {
            options.model = argv[index + 1] ?? options.model;
            index += 1;
            continue;
        }
        if (part === "--cwd") {
            options.cwd = path.resolve(argv[index + 1] ?? options.cwd);
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
        promptParts.push(part);
    }
    return {
        ...options,
        prompt: promptParts.join(" ").trim(),
    };
}
function buildSystemPrompt(cwd) {
    return [
        "You are Gradient Code, a local coding assistant running through application-managed tools.",
        "Inspect the workspace before proposing changes or commands.",
        "Use tools when they reduce guesswork.",
        "Prefer search_text before broad assumptions.",
        "Prefer read_file before making claims about file contents.",
        "Use run_command only when needed, and keep commands scoped to the workspace.",
        "Do not ask for tools by any name except the tools provided to you.",
        "If a tool fails, recover by inspecting the error and trying a smaller next step.",
        "When you are done, provide a concise final answer.",
        `Current workspace: ${cwd}`,
    ].join("\n");
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
        async execute(inputArgs) {
            if (approveAll) {
                return { ok: true, toolName: this.name, content: "approved" };
            }
            const rl = readline.createInterface({ input, output });
            const toolName = String(inputArgs.toolName ?? "tool");
            const summary = String(inputArgs.summary ?? "");
            const answer = await rl.question(`Approve ${toolName}? ${summary} [y/N] `);
            rl.close();
            const approved = /^y(es)?$/i.test(answer.trim());
            return { ok: true, toolName: this.name, content: approved ? "approved" : "denied" };
        },
    };
}
async function main() {
    await maybeLoadEnv(process.cwd());
    const options = parseArgs(process.argv.slice(2));
    if (!options.prompt) {
        throw new Error("Usage: npm run dev -- [--model MODEL] [--cwd PATH] [--approve-all] [--no-store] \"your prompt\"");
    }
    const apiKey = process.env.MODEL_ACCESS_KEY;
    if (!apiKey) {
        throw new Error("Missing MODEL_ACCESS_KEY. Add it to your environment or .env file.");
    }
    const provider = new GradientResponsesClient({
        apiKey,
        baseUrl: process.env.GRADIENT_BASE_URL,
    });
    const tools = [...getDefaultTools(), createApprovalTool(options.approveAll)];
    const cwd = path.resolve(options.cwd);
    console.log(`Model: ${options.model}`);
    console.log(`Workspace: ${cwd}`);
    console.log("");
    const result = await runAgent({
        model: options.model,
        cwd,
        userPrompt: options.prompt,
        systemPrompt: buildSystemPrompt(cwd),
        storeResponses: options.store,
    }, {
        provider,
        tools,
        onText: (text) => {
            console.log("Assistant:");
            console.log(text);
            console.log("");
        },
    });
    const transcriptPath = await writeTranscript(cwd, result.events);
    console.log(`Transcript: ${transcriptPath}`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map