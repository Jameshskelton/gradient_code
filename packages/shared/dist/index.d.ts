export type JsonSchema = {
    type: string;
    description?: string;
    required?: string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    enum?: string[];
};
export type PromptPreset = "default" | "research" | "plan" | "review" | "implement";
export type ToolPermissionLevel = "read" | "edit" | "execute" | "destructive";
export type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    requiresApproval?: boolean;
    permissionLevel?: ToolPermissionLevel;
};
export type ToolInvocation = {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
};
export type ToolResult = {
    ok: true;
    toolName: string;
    content: string;
    metadata?: Record<string, unknown>;
} | {
    ok: false;
    toolName: string;
    error: {
        code: string;
        message: string;
    };
    metadata?: Record<string, unknown>;
};
export type ToolContext = {
    cwd: string;
    previewEdits?: boolean;
    approve: (toolName: string, summary: string) => Promise<boolean>;
};
export type Tool = ToolDefinition & {
    execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};
export type AgentMessage = {
    role: "system" | "user";
    content: string;
} | {
    role: "assistant";
    content: string;
    toolCalls?: ToolInvocation[];
} | {
    role: "tool";
    toolName: string;
    callId: string;
    content: string;
    ok: boolean;
};
export type ProviderTextOutput = {
    type: "text";
    text: string;
};
export type ProviderToolCallOutput = {
    type: "tool_call";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
};
export type TokenUsage = {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
};
export type ProviderTurn = {
    id?: string;
    text: string;
    outputs: Array<ProviderTextOutput | ProviderToolCallOutput>;
    usage?: TokenUsage;
    raw: unknown;
};
export type ProviderRequest = {
    model: string;
    systemPrompt: string;
    messages: AgentMessage[];
    tools: ToolDefinition[];
    previousResponseId?: string;
    store?: boolean;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
};
export type ProviderStreamHandlers = {
    onTextDelta?: (chunk: string) => void;
};
export type ProviderClient = {
    createTurn: (request: ProviderRequest) => Promise<ProviderTurn>;
    createTurnStream?: (request: ProviderRequest, handlers: ProviderStreamHandlers) => Promise<ProviderTurn>;
};
export type SessionEvent = {
    type: "user";
    text: string;
    timestamp: string;
    runId?: string;
} | {
    type: "assistant";
    text: string;
    timestamp: string;
    runId?: string;
} | {
    type: "tool_call";
    toolName: string;
    callId: string;
    input: Record<string, unknown>;
    timestamp: string;
    runId?: string;
} | {
    type: "tool_result";
    toolName: string;
    callId: string;
    result: ToolResult;
    timestamp: string;
    runId?: string;
};
export type GradientCodeConfig = {
    model?: string;
    baseUrl?: string;
    storeResponses?: boolean;
    previewEdits?: boolean;
    approveAll?: boolean;
    maxTurns?: number;
    sessionId?: string;
    providerTimeoutMs?: number;
    toolTimeoutMs?: number;
    retryCount?: number;
    preset?: PromptPreset;
    includeProjectNotes?: boolean;
    projectNotesPath?: string;
};
export type ModelCapabilityProfile = {
    model: string;
    supportsStreaming: boolean;
    supportsToolCalling: boolean;
    preferredEndpoint: "chat_completions" | "responses";
    preferredStreamingEndpoint?: "chat_completions" | "responses";
    toolSchemaStyle?: "full" | "compact";
    toolPromptStyle?: "none" | "minimal" | "compact" | "full";
    supportsParallelToolCalls?: boolean;
    promptHints: string[];
};
export type AgentSessionState = {
    id: string;
    cwd: string;
    model: string;
    systemPrompt: string;
    messages: AgentMessage[];
    events: SessionEvent[];
    createdAt: string;
    updatedAt: string;
};
export type AgentRunOptions = {
    model: string;
    cwd: string;
    userPrompt: string;
    systemPrompt: string;
    preset?: PromptPreset;
    storeResponses?: boolean;
    previewEdits?: boolean;
    maxTurns?: number;
    initialMessages?: AgentMessage[];
    initialEvents?: SessionEvent[];
    sessionId?: string;
    toolTimeoutMs?: number;
    providerTimeoutMs?: number;
    abortSignal?: AbortSignal;
    runId?: string;
};
export type AgentRunResult = {
    finalText: string;
    events: SessionEvent[];
    messages: AgentMessage[];
    sessionId: string;
    runId: string;
    usage?: TokenUsage;
};
