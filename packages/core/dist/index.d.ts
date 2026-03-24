import type { AgentRunOptions, AgentRunResult, AgentSessionState, GradientCodeConfig, JsonSchema, ModelCapabilityProfile, PromptPreset, ProviderClient, SessionEvent, Tool, ToolInvocation, ToolPermissionLevel, ToolResult, TokenUsage } from "@gradient-code/shared";
export type SessionSummary = {
    id: string;
    cwd: string;
    model: string;
    createdAt: string;
    updatedAt: string;
    lastUserPrompt: string;
};
type RunAgentDependencies = {
    provider: ProviderClient;
    toolRegistry: ToolRegistry;
    onTextDelta?: (text: string) => void;
    onAssistantTurnComplete?: () => void;
    onTurnComplete?: (turn: {
        turnIndex: number;
        maxTurns: number;
        toolCalls: ToolInvocation[];
        usage?: TokenUsage;
    }) => void;
    onToolCall?: (toolCall: ToolInvocation) => void;
    onToolResult?: (toolCall: ToolInvocation, result: ToolResult) => void;
};
type PolicyDecision = {
    allowed: boolean;
    reason?: string;
};
export declare class ToolRegistry {
    private readonly toolsByName;
    constructor(tools: Tool[]);
    get(name: string): Tool | undefined;
    definitions(): {
        name: string;
        description: string;
        inputSchema: JsonSchema;
        requiresApproval?: boolean;
        permissionLevel?: ToolPermissionLevel;
    }[];
    all(): Tool[];
}
export declare class SandboxPolicy {
    private readonly destructivePatterns;
    decide(tool: Tool, input: Record<string, unknown>): PolicyDecision;
}
export declare function resolveProjectNotesPath(cwd: string, customPath?: string): string;
export declare function loadProjectNotes(cwd: string, config?: Pick<GradientCodeConfig, "includeProjectNotes" | "projectNotesPath">): Promise<string | null>;
export declare function buildAgentSystemPrompt(input: {
    cwd: string;
    profile: ModelCapabilityProfile;
    preset?: PromptPreset;
    projectNotes?: string | null;
}): string;
export declare function loadGradientCodeConfig(cwd: string): Promise<GradientCodeConfig>;
export declare function saveGradientCodeConfig(cwd: string, config: GradientCodeConfig): Promise<string>;
export declare function loadSession(cwd: string, sessionId: string): Promise<AgentSessionState | null>;
export declare function deleteSession(cwd: string, sessionId: string): Promise<boolean>;
export declare function loadLatestSession(cwd: string): Promise<AgentSessionState | null>;
export declare function listSessions(cwd: string): Promise<SessionSummary[]>;
export declare function saveSession(state: AgentSessionState): Promise<string>;
export declare function writeTranscript(cwd: string, events: SessionEvent[]): Promise<string>;
export declare function runAgent(options: AgentRunOptions, dependencies: RunAgentDependencies): Promise<AgentRunResult>;
export {};
