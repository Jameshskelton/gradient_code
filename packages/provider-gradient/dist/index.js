import http from "node:http";
import https from "node:https";
export const AVAILABLE_GRADIENT_MODELS = [
    { id: "anthropic-claude-4.5-sonnet", label: "Claude 4.5 Sonnet", family: "Anthropic" },
    { id: "anthropic-claude-4.1-opus", label: "Claude 4.1 Opus", family: "Anthropic" },
    { id: "anthropic-claude-4.1-sonnet", label: "Claude 4.1 Sonnet", family: "Anthropic" },
    { id: "anthropic-claude-3.7-sonnet", label: "Claude 3.7 Sonnet", family: "Anthropic" },
    { id: "deepseek-r1-0528", label: "DeepSeek R1 0528", family: "DeepSeek" },
    { id: "deepseek-v3-1", label: "DeepSeek V3.1", family: "DeepSeek" },
    { id: "glm-5", label: "GLM-5", family: "Zhipu AI" },
    { id: "kimi-k2.5", label: "Kimi-K2.5", family: "Moonshot AI" },
    {
        id: "meta-llama-4-maverick-17b-128e-instruct",
        label: "Llama 4 Maverick 17B 128E Instruct",
        family: "Meta",
    },
    { id: "minimax-m2.5", label: "MiniMax M2.5", family: "MiniMax" },
    { id: "mistral-medium-3.1", label: "Mistral Medium 3.1", family: "Mistral" },
    { id: "nvidia-nemotron-3-super-120b", label: "Nemotron-3-Super-120B", family: "NVIDIA" },
    { id: "openai-gpt-5.4", label: "GPT-5.4", family: "OpenAI" },
    { id: "openai-gpt-5.3-codex", label: "GPT-5.3-Codex", family: "OpenAI" },
    { id: "openai-gpt-5.2", label: "GPT-5.2", family: "OpenAI" },
    { id: "openai-gpt-5-2-pro", label: "GPT-5.2 Pro", family: "OpenAI" },
    { id: "openai-gpt-5.1-codex-max", label: "GPT-5.1-Codex-Max", family: "OpenAI" },
    { id: "openai-gpt-5", label: "GPT-5", family: "OpenAI" },
    { id: "openai-gpt-5-mini", label: "GPT-5 Mini", family: "OpenAI" },
    { id: "openai-gpt-5-nano", label: "GPT-5 Nano", family: "OpenAI" },
    { id: "openai-gpt-5.1", label: "GPT-5.1", family: "OpenAI" },
    { id: "openai-gpt-5.1-mini", label: "GPT-5.1 Mini", family: "OpenAI" },
    { id: "openai-gpt-5.1-nano", label: "GPT-5.1 Nano", family: "OpenAI" },
    { id: "openai-gpt-4.1", label: "GPT-4.1", family: "OpenAI" },
    { id: "openai-gpt-4o", label: "GPT-4o", family: "OpenAI" },
    { id: "openai-gpt-4o-mini", label: "GPT-4o Mini", family: "OpenAI" },
    { id: "openai-o1", label: "o1", family: "OpenAI" },
    { id: "openai-o3", label: "o3", family: "OpenAI" },
    { id: "openai-o3-mini", label: "o3-mini", family: "OpenAI" },
    { id: "openai-gpt-image-1", label: "GPT-image-1", family: "OpenAI" },
    { id: "openai-gpt-oss-120b", label: "gpt-oss-120b", family: "OpenAI" },
    { id: "openai-gpt-oss-20b", label: "gpt-oss-20b", family: "OpenAI" },
];
const MODEL_CAPABILITIES = {
    "glm-5": {
        model: "glm-5",
        supportsStreaming: false,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        toolSchemaStyle: "compact",
        toolPromptStyle: "compact",
        promptHints: [
            "Be explicit with tool arguments and prefer concise tool payloads.",
            "Before patching files, inspect the relevant file contents directly.",
            "Assume non-streaming responses unless runtime evidence proves streaming is stable.",
        ],
    },
    "openai-gpt-oss-20b": {
        model: "openai-gpt-oss-20b",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Keep answers concise unless the task specifically asks for detail.",
        ],
    },
    "openai-gpt-5.4": {
        model: "openai-gpt-5.4",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "responses",
        preferredStreamingEndpoint: "responses",
        toolSchemaStyle: "compact",
        toolPromptStyle: "compact",
        supportsParallelToolCalls: true,
        promptHints: [
            "This model is documented by DigitalOcean as `/v1/responses`-only for serverless inference.",
            "Prefer clear, tool-friendly reasoning and compact structured outputs.",
        ],
    },
    "openai-gpt-5.3-codex": {
        model: "openai-gpt-5.3-codex",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        toolSchemaStyle: "compact",
        toolPromptStyle: "compact",
        supportsParallelToolCalls: true,
        promptHints: [
            "Favor coding-focused, execution-oriented responses with clear next actions.",
        ],
    },
    "openai-gpt-5.2": {
        model: "openai-gpt-5.2",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Be precise with tool arguments and summarize results clearly before the next action.",
        ],
    },
    "openai-gpt-5-2-pro": {
        model: "openai-gpt-5-2-pro",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Use deeper reasoning when needed, but keep user-facing output concise and actionable.",
        ],
    },
    "openai-gpt-5.1-codex-max": {
        model: "openai-gpt-5.1-codex-max",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Stay highly coding-focused and move efficiently from inspection to implementation.",
        ],
    },
    "openai-gpt-5": {
        model: "openai-gpt-5",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Balance concise reasoning with practical execution details.",
        ],
    },
    "openai-gpt-5-mini": {
        model: "openai-gpt-5-mini",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Keep tool use efficient and avoid redundant inspections.",
        ],
    },
    "openai-gpt-5-nano": {
        model: "openai-gpt-5-nano",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Prefer short, explicit tool arguments and minimal context per turn.",
        ],
    },
    "openai-gpt-4.1": {
        model: "openai-gpt-4.1",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Be explicit when transitioning from analysis to edits.",
        ],
    },
    "openai-gpt-4o": {
        model: "openai-gpt-4o",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Use fast, practical tool loops and keep explanations approachable.",
        ],
    },
    "openai-gpt-4o-mini": {
        model: "openai-gpt-4o-mini",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Prefer compact summaries and efficient inspection steps.",
        ],
    },
    "openai-o1": {
        model: "openai-o1",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Favor deliberate reasoning, but keep the final response direct and useful.",
        ],
    },
    "openai-o3": {
        model: "openai-o3",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Take a rigorous approach to planning and implementation tasks.",
        ],
    },
    "openai-o3-mini": {
        model: "openai-o3-mini",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Use efficient reasoning and lean tool payloads.",
        ],
    },
    "openai-gpt-image-1": {
        model: "openai-gpt-image-1",
        supportsStreaming: false,
        supportsToolCalling: false,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "This is an image generation model and is not a strong fit for coding-agent tasks.",
        ],
    },
    "anthropic-claude-4.5-sonnet": {
        model: "anthropic-claude-4.5-sonnet",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Prefer reviewing changed files and surfacing risks before broad summaries.",
        ],
    },
    "kimi-k2.5": {
        model: "kimi-k2.5",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Stay concrete and execution-oriented, especially for coding and multi-step tasks.",
            "Prefer compact but complete tool summaries before asking for another tool.",
        ],
    },
    "minimax-m2.5": {
        model: "minimax-m2.5",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Favor concise, efficient tool use and avoid redundant inspections.",
            "For implementation tasks, move from inspection to edits decisively once context is sufficient.",
        ],
    },
    "nvidia-nemotron-3-super-120b": {
        model: "nvidia-nemotron-3-super-120b",
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Use structured reasoning, but keep the final user response compact and actionable.",
        ],
    },
};
export function normalizeProviderModelName(model) {
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
function withCapabilityDefaults(profile) {
    const toolPromptStyle = profile.toolPromptStyle ??
        (profile.supportsToolCalling ? (profile.preferredEndpoint === "responses" ? "compact" : "minimal") : "none");
    return {
        ...profile,
        preferredStreamingEndpoint: profile.preferredStreamingEndpoint ??
            (profile.supportsStreaming ? profile.preferredEndpoint : undefined),
        toolSchemaStyle: profile.toolSchemaStyle ?? (profile.preferredEndpoint === "responses" ? "compact" : "full"),
        toolPromptStyle,
        supportsParallelToolCalls: profile.supportsParallelToolCalls ?? profile.model.startsWith("openai-"),
    };
}
function buildProviderError(statusCode, responseBody, model) {
    const error = statusCode === 404 && responseBody.includes("model not found")
        ? new Error(`Gradient model "${model}" was not found. This usually means the selected model ID is not in the current DigitalOcean catalog or is unavailable for this account.`)
        : new Error(`Gradient request failed (${statusCode}): ${responseBody}`);
    Object.assign(error, {
        statusCode,
        responseBody,
    });
    return error;
}
function getStatusCodeFromError(error) {
    const statusCode = error?.statusCode;
    return typeof statusCode === "number" ? statusCode : null;
}
function isRetryableStatus(statusCode) {
    return statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500);
}
function isResponsesEndpointMismatch(error) {
    const message = error instanceof Error ? error.message : String(error);
    return (message.includes("not supported in the v1/responses endpoint") ||
        message.includes("Did you mean to use v1/chat/completions") ||
        message.includes("unsupported in the v1/responses endpoint"));
}
function isChatEndpointMismatch(error) {
    const message = error instanceof Error ? error.message : String(error);
    return (message.includes("not supported in the v1/chat/completions endpoint") ||
        message.includes("This is not a chat model") ||
        message.includes("use v1/completions"));
}
export function resolveModelCapabilityProfile(model) {
    const normalizedModel = normalizeProviderModelName(model);
    return withCapabilityDefaults(MODEL_CAPABILITIES[normalizedModel] ?? {
        model: normalizedModel,
        supportsStreaming: true,
        supportsToolCalling: true,
        preferredEndpoint: "chat_completions",
        promptHints: [
            "Use strictly valid JSON arguments for tool calls.",
        ],
    });
}
function toMessages(systemPrompt, messages) {
    const result = [{ role: "system", content: systemPrompt }];
    for (const message of messages) {
        if (message.role === "system" || message.role === "user") {
            result.push({
                role: message.role,
                content: message.content,
            });
            continue;
        }
        if (message.role === "assistant") {
            result.push({
                role: "assistant",
                content: message.content,
                tool_calls: message.toolCalls?.map((toolCall) => ({
                    id: toolCall.callId,
                    type: "function",
                    function: {
                        name: toolCall.name,
                        arguments: JSON.stringify(toolCall.arguments),
                    },
                })),
            });
            continue;
        }
        if (message.role === "tool") {
            result.push({
                role: "tool",
                tool_call_id: message.callId,
                content: message.content,
            });
        }
    }
    return result;
}
function compactSchema(schema) {
    const next = {
        type: schema.type,
    };
    if (schema.required) {
        next.required = [...schema.required];
    }
    if (schema.enum) {
        next.enum = [...schema.enum];
    }
    if (schema.items) {
        next.items = compactSchema(schema.items);
    }
    if (schema.properties) {
        next.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, compactSchema(value)]));
    }
    return next;
}
function summarizeSchemaParameters(schema) {
    if (!schema.properties) {
        return "";
    }
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties)
        .map(([name, property]) => `${name}${required.has(name) ? "*" : ""}:${property.type}`)
        .join(", ");
}
function buildCapabilityToolPrompt(profile, tools) {
    if (!profile.supportsToolCalling || tools.length === 0 || profile.toolPromptStyle === "none") {
        return "";
    }
    const lines = ["Tool usage guidance:"];
    if (profile.toolPromptStyle === "minimal") {
        lines.push(`You may call tools when they reduce guesswork. Available tools: ${tools.map((tool) => tool.name).join(", ")}.`);
        lines.push("When calling a tool, use valid JSON arguments that match the declared schema exactly.");
        return lines.join("\n");
    }
    for (const tool of tools) {
        const parameterSummary = summarizeSchemaParameters(tool.inputSchema);
        if (profile.toolPromptStyle === "compact") {
            lines.push(`- ${tool.name}(${parameterSummary || "no args"})`);
            continue;
        }
        lines.push(`- ${tool.name}(${parameterSummary || "no args"}): ${tool.description}`);
    }
    lines.push("Only call tools with valid JSON arguments and only when they clearly help the task.");
    return lines.join("\n");
}
function adaptToolsForProfile(profile, tools) {
    if (!profile.supportsToolCalling) {
        return [];
    }
    if (profile.toolSchemaStyle !== "compact") {
        return tools;
    }
    return tools.map((tool) => ({
        ...tool,
        description: tool.description.split(".")[0] ?? tool.description,
        inputSchema: compactSchema(tool.inputSchema),
    }));
}
function toTools(tools) {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));
}
function toResponsesTools(tools) {
    return tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
    }));
}
function buildResponsesInput(messages) {
    const items = [];
    for (const message of messages) {
        if (message.role === "system" || message.role === "user") {
            items.push({
                type: "message",
                role: message.role,
                content: [
                    {
                        type: "input_text",
                        text: message.content,
                    },
                ],
            });
            continue;
        }
        if (message.role === "assistant") {
            if (message.content.trim()) {
                items.push({
                    type: "message",
                    role: "assistant",
                    content: [
                        {
                            type: "output_text",
                            text: message.content,
                        },
                    ],
                });
            }
            for (const toolCall of message.toolCalls ?? []) {
                items.push({
                    type: "function_call",
                    call_id: toolCall.callId,
                    name: toolCall.name,
                    arguments: JSON.stringify(toolCall.arguments),
                });
            }
            continue;
        }
        if (message.role === "tool") {
            items.push({
                type: "function_call_output",
                call_id: message.callId,
                output: message.content,
            });
        }
    }
    return items;
}
function parseArguments(raw) {
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            return {};
        }
    }
    return raw && typeof raw === "object" ? raw : {};
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parseTokenUsage(usage) {
    if (!usage || typeof usage !== "object") {
        return undefined;
    }
    const inputTokens = asNumber(usage.input_tokens) ??
        asNumber(usage.prompt_tokens) ??
        asNumber(usage.inputTokens) ??
        asNumber(usage.promptTokens);
    const outputTokens = asNumber(usage.output_tokens) ??
        asNumber(usage.completion_tokens) ??
        asNumber(usage.outputTokens) ??
        asNumber(usage.completionTokens);
    const totalTokens = asNumber(usage.total_tokens) ??
        asNumber(usage.totalTokens) ??
        (typeof inputTokens === "number" || typeof outputTokens === "number"
            ? (inputTokens ?? 0) + (outputTokens ?? 0)
            : undefined);
    if (typeof inputTokens !== "number" &&
        typeof outputTokens !== "number" &&
        typeof totalTokens !== "number") {
        return undefined;
    }
    return {
        inputTokens,
        outputTokens,
        totalTokens,
    };
}
function extractStreamingUsage(rawEvents) {
    for (let index = rawEvents.length - 1; index >= 0; index -= 1) {
        const event = rawEvents[index];
        const usage = parseTokenUsage(event?.usage) ??
            parseTokenUsage(event?.response?.usage) ??
            parseTokenUsage(event?.x_groq?.usage);
        if (usage) {
            return usage;
        }
    }
    return undefined;
}
function mergeTextFragments(existing, incoming) {
    const current = existing.trimEnd();
    const next = incoming.trim();
    if (!next) {
        return current;
    }
    if (!current) {
        return next;
    }
    if (next.startsWith(current)) {
        return next;
    }
    if (current.startsWith(next) || current.includes(next)) {
        return current;
    }
    const maxOverlap = Math.min(current.length, next.length);
    for (let size = maxOverlap; size >= 12; size -= 1) {
        if (current.slice(-size) === next.slice(0, size)) {
            return `${current}${next.slice(size)}`;
        }
    }
    return `${current}\n${next}`;
}
function reconcileStreamingSnapshot(existing, incoming) {
    const current = existing.trimEnd();
    const next = incoming.trim();
    if (!next) {
        return {
            text: current,
            delta: "",
        };
    }
    if (!current) {
        return {
            text: next,
            delta: next,
        };
    }
    if (next.startsWith(current)) {
        return {
            text: next,
            delta: next.slice(current.length),
        };
    }
    if (current.startsWith(next) || current.includes(next)) {
        return {
            text: current,
            delta: "",
        };
    }
    if (next.includes(current)) {
        return {
            text: next,
            delta: "",
        };
    }
    const normalizedCurrent = current.replace(/\s+/g, " ").trim();
    const normalizedNext = next.replace(/\s+/g, " ").trim();
    if (normalizedCurrent && normalizedCurrent === normalizedNext) {
        return {
            text: next.length >= current.length ? next : current,
            delta: "",
        };
    }
    const maxOverlap = Math.min(current.length, next.length);
    for (let size = maxOverlap; size >= 12; size -= 1) {
        if (current.slice(-size) === next.slice(0, size)) {
            return {
                text: `${current}${next.slice(size)}`,
                delta: next.slice(size),
            };
        }
    }
    // Completed snapshots should not replay the entire response if overlap detection is ambiguous.
    return {
        text: next.length >= current.length ? next : current,
        delta: "",
    };
}
function extractResponseTextPart(part) {
    if (!part || typeof part !== "object") {
        return "";
    }
    if (part.type === "output_text" && typeof part.text === "string") {
        return part.text;
    }
    if (part.type === "input_text" && typeof part.text === "string") {
        return part.text;
    }
    if (typeof part.text === "string") {
        return part.text;
    }
    if (part.text && typeof part.text === "object" && typeof part.text.value === "string") {
        return part.text.value;
    }
    if (typeof part.output_text === "string") {
        return part.output_text;
    }
    if (typeof part.content === "string") {
        return part.content;
    }
    return "";
}
function extractResponseItemText(item) {
    if (!item || typeof item !== "object") {
        return "";
    }
    if (typeof item.text === "string") {
        return item.text;
    }
    if (Array.isArray(item.content)) {
        return item.content
            .map((part) => extractResponseTextPart(part))
            .filter((fragment) => fragment.trim().length > 0)
            .join("\n")
            .trim();
    }
    return "";
}
function extractTopLevelResponseText(payload) {
    if (typeof payload?.output_text === "string") {
        return payload.output_text.trim();
    }
    if (Array.isArray(payload?.output_text)) {
        return payload.output_text
            .map((part) => {
            if (typeof part === "string") {
                return part;
            }
            if (part && typeof part === "object" && typeof part.text === "string") {
                return part.text;
            }
            return "";
        })
            .filter((fragment) => fragment.trim().length > 0)
            .join("\n")
            .trim();
    }
    return "";
}
function parseResponsesTurn(payload) {
    const outputs = [];
    let text = "";
    const topLevelText = extractTopLevelResponseText(payload);
    if (topLevelText) {
        text = mergeTextFragments(text, topLevelText);
    }
    for (const item of payload?.output ?? []) {
        if (item?.type === "message") {
            const itemText = extractResponseItemText(item);
            if (!topLevelText && itemText) {
                text = mergeTextFragments(text, itemText);
            }
            continue;
        }
        if (item?.type === "function_call") {
            outputs.push({
                type: "tool_call",
                callId: item.call_id ?? item.id ?? crypto.randomUUID(),
                name: String(item.name ?? ""),
                arguments: parseArguments(item.arguments),
            });
        }
    }
    if (text) {
        outputs.unshift({
            type: "text",
            text,
        });
    }
    return {
        id: payload?.id,
        text,
        outputs,
        usage: parseTokenUsage(payload?.usage),
        raw: payload,
    };
}
function parseTurnResponse(payload) {
    const outputs = [];
    const message = payload?.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content : "";
    if (content) {
        outputs.push({
            type: "text",
            text: content,
        });
    }
    for (const toolCall of message?.tool_calls ?? []) {
        if (toolCall?.type === "function") {
            outputs.push({
                type: "tool_call",
                callId: toolCall.id ?? crypto.randomUUID(),
                name: toolCall.function?.name,
                arguments: parseArguments(toolCall.function?.arguments),
            });
        }
    }
    const text = outputs
        .filter((output) => output.type === "text")
        .map((output) => output.text)
        .join("\n")
        .trim();
    return {
        id: payload?.id,
        text,
        outputs,
        usage: parseTokenUsage(payload?.usage),
        raw: payload,
    };
}
function parseChatStreamingDelta(payload, accumulator, handlers) {
    const choice = payload?.choices?.[0];
    const delta = choice?.delta;
    if (payload?.id) {
        accumulator.id = payload.id;
    }
    if (typeof delta?.content === "string") {
        accumulator.content += delta.content;
        handlers.onTextDelta?.(delta.content);
    }
    for (const toolCallDelta of delta?.tool_calls ?? []) {
        const index = Number(toolCallDelta.index ?? 0);
        const existing = accumulator.toolCalls.get(index) ?? { arguments: "" };
        if (toolCallDelta.id) {
            existing.callId = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
            existing.name = toolCallDelta.function.name;
        }
        if (typeof toolCallDelta.function?.arguments === "string") {
            existing.arguments += toolCallDelta.function.arguments;
        }
        accumulator.toolCalls.set(index, existing);
    }
}
function finalizeChatStreamingTurn(accumulator, rawEvents) {
    const outputs = [];
    if (accumulator.content.trim()) {
        outputs.push({
            type: "text",
            text: accumulator.content.trim(),
        });
    }
    for (const toolCall of [...accumulator.toolCalls.values()]) {
        if (!toolCall.name) {
            continue;
        }
        outputs.push({
            type: "tool_call",
            callId: toolCall.callId ?? crypto.randomUUID(),
            name: toolCall.name,
            arguments: parseArguments(toolCall.arguments),
        });
    }
    return {
        id: accumulator.id,
        text: accumulator.content.trim(),
        outputs,
        usage: extractStreamingUsage(rawEvents),
        raw: rawEvents,
    };
}
function responsesToolCallKey(payload) {
    return String(payload?.item_id ?? payload?.item?.id ?? payload?.call_id ?? payload?.output_index ?? "0");
}
function ensureResponsesToolCall(accumulator, key) {
    const existing = accumulator.toolCalls.get(key) ?? { arguments: "" };
    accumulator.toolCalls.set(key, existing);
    return existing;
}
function applyResponsesOutputItem(item, accumulator, handlers) {
    if (!item || typeof item !== "object") {
        return;
    }
    if (item.type === "function_call") {
        const key = String(item.id ?? item.call_id ?? accumulator.toolCalls.size);
        const entry = ensureResponsesToolCall(accumulator, key);
        if (typeof item.call_id === "string") {
            entry.callId = item.call_id;
        }
        if (typeof item.name === "string") {
            entry.name = item.name;
        }
        if (typeof item.arguments === "string" && item.arguments.length >= entry.arguments.length) {
            entry.arguments = item.arguments;
        }
        return;
    }
    const text = extractResponseItemText(item);
    if (text) {
        const next = mergeTextFragments(accumulator.content, text);
        const delta = next.slice(accumulator.content.length);
        accumulator.content = next;
        if (delta) {
            handlers.onTextDelta?.(delta);
        }
    }
}
function parseResponsesStreamingEvent(payload, accumulator, handlers) {
    switch (payload?.type) {
        case "response.created":
            accumulator.id = payload.response?.id ?? accumulator.id;
            return;
        case "response.output_text.delta":
            if (typeof payload.delta === "string") {
                accumulator.content += payload.delta;
                handlers.onTextDelta?.(payload.delta);
            }
            return;
        case "response.output_text.done":
            if (typeof payload.text === "string") {
                accumulator.content = reconcileStreamingSnapshot(accumulator.content, payload.text).text;
            }
            return;
        case "response.function_call_arguments.delta": {
            const entry = ensureResponsesToolCall(accumulator, responsesToolCallKey(payload));
            if (typeof payload.delta === "string") {
                entry.arguments += payload.delta;
            }
            return;
        }
        case "response.function_call_arguments.done": {
            const entry = ensureResponsesToolCall(accumulator, responsesToolCallKey(payload));
            if (typeof payload.arguments === "string" && payload.arguments.length >= entry.arguments.length) {
                entry.arguments = payload.arguments;
            }
            return;
        }
        case "response.output_item.added":
        case "response.output_item.done":
            applyResponsesOutputItem(payload.item, accumulator, handlers);
            return;
        case "response.completed":
            accumulator.id = payload.response?.id ?? accumulator.id;
            accumulator.completedResponse = payload.response;
            if (payload.response) {
                const parsed = parseResponsesTurn(payload.response);
                const snapshot = reconcileStreamingSnapshot(accumulator.content, parsed.text);
                accumulator.content = snapshot.text;
                if (snapshot.delta) {
                    handlers.onTextDelta?.(snapshot.delta);
                }
                for (const output of parsed.outputs) {
                    if (output.type !== "tool_call") {
                        continue;
                    }
                    const entry = ensureResponsesToolCall(accumulator, output.callId);
                    entry.callId = output.callId;
                    entry.name = output.name;
                    entry.arguments = JSON.stringify(output.arguments);
                }
            }
            return;
        case "error":
            throw new Error(typeof payload.error?.message === "string" ? payload.error.message : "Responses stream failed");
        case "response.failed":
            throw new Error(typeof payload.response?.error?.message === "string" ? payload.response.error.message : "Responses stream failed");
        default:
            return;
    }
}
function finalizeResponsesStreamingTurn(accumulator, rawEvents) {
    if (accumulator.completedResponse) {
        const parsed = parseResponsesTurn(accumulator.completedResponse);
        const mergedText = mergeTextFragments(parsed.text, accumulator.content);
        const outputs = [
            ...parsed.outputs.filter((output) => output.type !== "text"),
        ];
        if (mergedText) {
            outputs.unshift({
                type: "text",
                text: mergedText,
            });
        }
        return {
            ...parsed,
            text: mergedText,
            outputs,
            usage: parseTokenUsage(accumulator.completedResponse?.usage) ?? extractStreamingUsage(rawEvents),
            raw: rawEvents,
        };
    }
    const outputs = [];
    const text = accumulator.content.trim();
    if (text) {
        outputs.push({
            type: "text",
            text,
        });
    }
    for (const toolCall of accumulator.toolCalls.values()) {
        if (!toolCall.name) {
            continue;
        }
        outputs.push({
            type: "tool_call",
            callId: toolCall.callId ?? crypto.randomUUID(),
            name: toolCall.name,
            arguments: parseArguments(toolCall.arguments),
        });
    }
    return {
        id: accumulator.id,
        text,
        outputs,
        usage: extractStreamingUsage(rawEvents),
        raw: rawEvents,
    };
}
function parseSseEvent(record) {
    const lines = record.split(/\r?\n/);
    let eventName;
    const dataLines = [];
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        if (line.startsWith(":")) {
            continue;
        }
        if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
            continue;
        }
        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
        }
    }
    if (dataLines.length === 0) {
        return null;
    }
    return {
        event: eventName,
        data: dataLines.join("\n"),
    };
}
function requestWithNodeHttp(urlText, body, headers, timeoutMs, signal, onDebug) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlText);
        const transport = url.protocol === "https:" ? https : http;
        let settled = false;
        let timeoutHandle;
        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            request.setTimeout(0);
        };
        const settleResolve = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(value);
        };
        const settleReject = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const request = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: {
                ...headers,
                "content-length": Buffer.byteLength(body).toString(),
            },
        }, (response) => {
            onDebug?.(`provider:node-http response status=${String(response.statusCode ?? 0)} encoding=${String(response.headers["content-encoding"] ?? "none")}`);
            let responseBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                responseBody += chunk;
            });
            response.on("end", () => {
                settleResolve({
                    statusCode: response.statusCode ?? 0,
                    body: responseBody,
                });
            });
        });
        request.on("socket", (socket) => {
            onDebug?.("provider:node-http socket assigned");
            socket.on("connect", () => {
                onDebug?.("provider:node-http socket connect");
            });
            socket.on("secureConnect", () => {
                onDebug?.("provider:node-http socket secureConnect");
            });
        });
        timeoutHandle = setTimeout(() => {
            onDebug?.(`provider:node-http timeout after ${timeoutMs}ms`);
            request.destroy(new Error(`Fetch timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        request.on("error", (error) => {
            settleReject(error instanceof Error ? error : new Error(String(error)));
        });
        const abortRequest = () => {
            onDebug?.("provider:node-http aborted");
            request.destroy(new Error("Run cancelled."));
        };
        if (signal) {
            if (signal.aborted) {
                abortRequest();
                return;
            }
            signal.addEventListener("abort", abortRequest, { once: true });
            request.on("close", () => {
                signal.removeEventListener("abort", abortRequest);
            });
        }
        request.write(body);
        request.end();
    });
}
function requestSseWithNodeHttp(urlText, body, headers, timeoutMs, signal, onDebug, model, onEvent) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlText);
        const transport = url.protocol === "https:" ? https : http;
        let settled = false;
        let timeoutHandle;
        const clearInactivityTimeout = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
        };
        const resetInactivityTimeout = () => {
            clearInactivityTimeout();
            timeoutHandle = setTimeout(() => {
                onDebug?.(`provider:node-http timeout after ${timeoutMs}ms`);
                request.destroy(new Error(`Fetch timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        };
        const cleanup = () => {
            clearInactivityTimeout();
            request.setTimeout(0);
        };
        const settleResolve = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };
        const settleReject = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const request = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: {
                ...headers,
                accept: "text/event-stream",
                "content-length": Buffer.byteLength(body).toString(),
            },
        }, (response) => {
            onDebug?.(`provider:node-http response status=${String(response.statusCode ?? 0)} encoding=${String(response.headers["content-encoding"] ?? "none")}`);
            if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
                let errorBody = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                    errorBody += chunk;
                });
                response.on("end", () => {
                    settleReject(buildProviderError(response.statusCode ?? 0, errorBody, model));
                });
                return;
            }
            let buffer = "";
            response.setEncoding("utf8");
            resetInactivityTimeout();
            response.on("data", (chunk) => {
                resetInactivityTimeout();
                buffer += chunk;
                const parts = buffer.split(/\r?\n\r?\n/);
                buffer = parts.pop() ?? "";
                for (const part of parts) {
                    const event = parseSseEvent(part);
                    if (event) {
                        onEvent(event);
                    }
                }
            });
            response.on("end", () => {
                if (buffer.trim()) {
                    const event = parseSseEvent(buffer);
                    if (event) {
                        onEvent(event);
                    }
                }
                settleResolve();
            });
        });
        request.on("socket", (socket) => {
            onDebug?.("provider:node-http socket assigned");
            socket.on("connect", () => {
                onDebug?.("provider:node-http socket connect");
            });
            socket.on("secureConnect", () => {
                onDebug?.("provider:node-http socket secureConnect");
            });
        });
        resetInactivityTimeout();
        request.on("error", (error) => {
            settleReject(error instanceof Error ? error : new Error(String(error)));
        });
        const abortRequest = () => {
            onDebug?.("provider:node-http aborted");
            request.destroy(new Error("Run cancelled."));
        };
        if (signal) {
            if (signal.aborted) {
                abortRequest();
                return;
            }
            signal.addEventListener("abort", abortRequest, { once: true });
            request.on("close", () => {
                signal.removeEventListener("abort", abortRequest);
            });
        }
        request.write(body);
        request.end();
    });
}
function prepareProviderRequest(request) {
    const model = normalizeProviderModelName(request.model);
    const profile = resolveModelCapabilityProfile(model);
    const tools = adaptToolsForProfile(profile, request.tools);
    const toolPrompt = buildCapabilityToolPrompt(profile, tools);
    const systemPrompt = toolPrompt ? `${request.systemPrompt}\n\n${toolPrompt}` : request.systemPrompt;
    return {
        model,
        profile,
        systemPrompt,
        tools,
    };
}
function buildRequestBody(endpoint, request, prepared, stream) {
    const parallelToolCalls = prepared.tools.length > 0 && prepared.profile.supportsParallelToolCalls === true ? true : undefined;
    if (endpoint === "responses") {
        return {
            model: prepared.model,
            instructions: prepared.systemPrompt,
            input: buildResponsesInput(request.messages),
            tools: toResponsesTools(prepared.tools),
            tool_choice: prepared.tools.length > 0 ? "auto" : undefined,
            parallel_tool_calls: parallelToolCalls,
            store: request.store ?? false,
            stream,
        };
    }
    return {
        model: prepared.model,
        messages: toMessages(prepared.systemPrompt, request.messages),
        tools: prepared.tools.length > 0 ? toTools(prepared.tools) : undefined,
        tool_choice: prepared.tools.length > 0 ? "auto" : undefined,
        parallel_tool_calls: parallelToolCalls,
        stream,
    };
}
function parseEndpointTurn(endpoint, payload) {
    return endpoint === "responses" ? parseResponsesTurn(payload) : parseTurnResponse(payload);
}
function preferredStreamEndpoint(profile) {
    if (!profile.supportsStreaming) {
        return null;
    }
    return profile.preferredStreamingEndpoint ?? profile.preferredEndpoint;
}
export class GradientChatCompletionsClient {
    baseUrl;
    apiKey;
    retryCount;
    onDebug;
    constructor(options) {
        this.baseUrl = options.baseUrl ?? "https://inference.do-ai.run/v1";
        this.apiKey = options.apiKey;
        this.retryCount = options.retryCount ?? 2;
        this.onDebug = options.onDebug;
    }
    endpointUrl(endpoint) {
        return endpoint === "responses" ? `${this.baseUrl}/responses` : `${this.baseUrl}/chat/completions`;
    }
    requestHeaders() {
        return {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
        };
    }
    async fetchWithRetry(request, prepared, endpoint) {
        let lastError;
        const timeoutMs = request.timeoutMs ?? 60_000;
        const url = this.endpointUrl(endpoint);
        const requestBody = JSON.stringify(buildRequestBody(endpoint, request, prepared, false));
        const requestHeaders = this.requestHeaders();
        for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
            this.onDebug?.(`provider:attempt ${attempt + 1}/${this.retryCount + 1} endpoint=${endpoint} stream=false model=${request.model} timeoutMs=${String(timeoutMs)} url=${url}`);
            try {
                const response = await requestWithNodeHttp(url, requestBody, requestHeaders, timeoutMs, request.abortSignal, this.onDebug);
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    this.onDebug?.(`provider:response ok status=${response.statusCode} endpoint=${endpoint} stream=false attempt=${attempt + 1}`);
                    return response;
                }
                const responseBody = response.body;
                const retryable = isRetryableStatus(response.statusCode);
                this.onDebug?.(`provider:response error status=${response.statusCode} endpoint=${endpoint} retryable=${String(retryable)} attempt=${attempt + 1} body=${responseBody.slice(0, 240)}`);
                lastError = buildProviderError(response.statusCode, responseBody, request.model);
                if (!retryable || attempt === this.retryCount) {
                    throw lastError;
                }
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                this.onDebug?.(`provider:fetch error attempt=${attempt + 1} message=${lastError.message}`);
                if (request.abortSignal?.aborted) {
                    throw lastError;
                }
                if (attempt === this.retryCount) {
                    throw lastError;
                }
            }
            const backoffMs = 500 * 2 ** attempt;
            this.onDebug?.(`provider:backoff ${backoffMs}ms before retry`);
            await new Promise((resolve) => {
                setTimeout(resolve, backoffMs);
            });
        }
        throw lastError ?? new Error("Gradient request failed without a specific error");
    }
    async streamWithRetry(request, prepared, endpoint, handlers) {
        let lastError;
        const timeoutMs = request.timeoutMs ?? 60_000;
        const url = this.endpointUrl(endpoint);
        const requestBody = JSON.stringify(buildRequestBody(endpoint, request, prepared, true));
        const requestHeaders = this.requestHeaders();
        for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
            const rawEvents = [];
            const chatAccumulator = {
                content: "",
                toolCalls: new Map(),
            };
            const responsesAccumulator = {
                content: "",
                toolCalls: new Map(),
            };
            let receivedPayload = false;
            this.onDebug?.(`provider:attempt ${attempt + 1}/${this.retryCount + 1} endpoint=${endpoint} stream=true model=${request.model} timeoutMs=${String(timeoutMs)} url=${url}`);
            try {
                await requestSseWithNodeHttp(url, requestBody, requestHeaders, timeoutMs, request.abortSignal, this.onDebug, request.model, (event) => {
                    if (!event.data || event.data === "[DONE]") {
                        return;
                    }
                    const payload = JSON.parse(event.data);
                    rawEvents.push(payload);
                    receivedPayload = true;
                    if (endpoint === "responses") {
                        parseResponsesStreamingEvent(payload, responsesAccumulator, handlers);
                    }
                    else {
                        parseChatStreamingDelta(payload, chatAccumulator, handlers);
                    }
                });
                this.onDebug?.(`provider:response ok status=200 endpoint=${endpoint} stream=true attempt=${attempt + 1}`);
                return endpoint === "responses"
                    ? finalizeResponsesStreamingTurn(responsesAccumulator, rawEvents)
                    : finalizeChatStreamingTurn(chatAccumulator, rawEvents);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const statusCode = getStatusCodeFromError(lastError);
                const retryable = !receivedPayload && isRetryableStatus(statusCode);
                this.onDebug?.(`provider:stream error endpoint=${endpoint} attempt=${attempt + 1} retryable=${String(retryable)} message=${lastError.message}`);
                if (request.abortSignal?.aborted) {
                    throw lastError;
                }
                if (!retryable || attempt === this.retryCount) {
                    throw lastError;
                }
            }
            const backoffMs = 500 * 2 ** attempt;
            this.onDebug?.(`provider:backoff ${backoffMs}ms before retry`);
            await new Promise((resolve) => {
                setTimeout(resolve, backoffMs);
            });
        }
        throw lastError ?? new Error("Gradient streaming request failed without a specific error");
    }
    async createTurnWithEndpoint(request, prepared, endpoint) {
        const response = await this.fetchWithRetry(request, prepared, endpoint);
        const payload = JSON.parse(response.body);
        return parseEndpointTurn(endpoint, payload);
    }
    async createTurn(request) {
        const prepared = prepareProviderRequest(request);
        if (prepared.profile.preferredEndpoint === "responses") {
            this.onDebug?.(`provider:preferred endpoint responses for model ${request.model}`);
            try {
                return await this.createTurnWithEndpoint(request, prepared, "responses");
            }
            catch (error) {
                if (!isResponsesEndpointMismatch(error)) {
                    throw error;
                }
                this.onDebug?.(`provider:responses endpoint rejected ${request.model}, falling back to chat/completions`);
                return this.createTurnWithEndpoint(request, prepared, "chat_completions");
            }
        }
        try {
            return await this.createTurnWithEndpoint(request, prepared, "chat_completions");
        }
        catch (error) {
            if (!isChatEndpointMismatch(error)) {
                throw error;
            }
            this.onDebug?.(`provider:chat endpoint rejected ${request.model}, falling back to responses`);
            return this.createTurnWithEndpoint(request, prepared, "responses");
        }
    }
    async createTurnStream(request, handlers) {
        const prepared = prepareProviderRequest(request);
        const streamEndpoint = preferredStreamEndpoint(prepared.profile);
        if (!streamEndpoint) {
            this.onDebug?.(`provider:stream disabled for model ${request.model}, using non-streaming ${prepared.profile.preferredEndpoint} turn`);
            return this.createTurn(request);
        }
        try {
            return await this.streamWithRetry(request, prepared, streamEndpoint, handlers);
        }
        catch (error) {
            const fallbackToResponses = streamEndpoint === "chat_completions" && isChatEndpointMismatch(error);
            const fallbackToChat = streamEndpoint === "responses" && isResponsesEndpointMismatch(error);
            this.onDebug?.(`provider:stream failed for ${request.model}, falling back to non-streaming${fallbackToResponses ? " responses" : fallbackToChat ? " chat/completions" : ""}`);
            return this.createTurn(request).catch((fallbackError) => {
                const primary = error instanceof Error ? error.message : String(error);
                const secondary = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                throw new Error(`Streaming request failed and non-streaming fallback also failed. stream="${primary}" fallback="${secondary}"`);
            });
        }
    }
}
export const GradientResponsesClient = GradientChatCompletionsClient;
//# sourceMappingURL=index.js.map