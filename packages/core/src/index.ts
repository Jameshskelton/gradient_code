import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentSessionState,
  GradientCodeConfig,
  JsonSchema,
  ModelCapabilityProfile,
  PromptPreset,
  ProviderClient,
  SessionEvent,
  Tool,
  ToolInvocation,
  ToolPermissionLevel,
  ToolResult,
  TokenUsage,
} from "@gradient-code/shared";

export type SessionSummary = {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  lastUserPrompt: string;
};

const PRESET_INSTRUCTIONS: Record<PromptPreset, string[]> = {
  default: [
    "Be moderately verbose by default: explain your reasoning, what you found, and the next action in clear prose.",
    "Before using a tool or making an edit, briefly tell the user what you are about to do and why in one or two sentences unless the user asked for maximum brevity.",
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

export class ToolRegistry {
  private readonly toolsByName: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  get(name: string): Tool | undefined {
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
  private readonly destructivePatterns = [
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

  decide(tool: Tool, input: Record<string, unknown>): PolicyDecision {
    const permissionLevel: ToolPermissionLevel = tool.permissionLevel ?? "read";

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

function timestamp(): string {
  return new Date().toISOString();
}

function gradientCodeDir(cwd: string): string {
  return path.join(cwd, ".gradient-code");
}

export function resolveProjectNotesPath(cwd: string, customPath?: string): string {
  return customPath ? path.resolve(cwd, customPath) : path.join(gradientCodeDir(cwd), "project-notes.md");
}

export async function loadProjectNotes(cwd: string, config?: Pick<GradientCodeConfig, "includeProjectNotes" | "projectNotesPath">): Promise<string | null> {
  if (config?.includeProjectNotes === false) {
    return null;
  }

  const filePath = resolveProjectNotesPath(cwd, config?.projectNotesPath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export function buildAgentSystemPrompt(input: {
  cwd: string;
  profile: ModelCapabilityProfile;
  preset?: PromptPreset;
  projectNotes?: string | null;
}): string {
  const preset = input.preset ?? "default";

  const lines = [
    "You are Gradient Code, a local coding assistant running through application-managed tools.",
    "Inspect the workspace before proposing changes or commands.",
    "When the user asks for a plan, inspect the repo first and then return a concrete step-by-step implementation plan.",
    "When the user asks for a code review, focus first on bugs, regressions, risks, and missing tests before summaries.",
    "Use tools when they reduce guesswork.",
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
    "For reviews, inspect changed files or relevant files before making claims.",
    "For reviews, prefer a findings-first format with explicit severity, evidence, likely impact, and missing-test callouts.",
    "For plans, explain phases, milestones, and key risks.",
    "Prefer user-visible narration over silent tool use when possible.",
    "Before each meaningful tool call, give a short explanation of what you are checking or changing and why.",
    "After tool results, summarize the takeaway before moving to the next action when that helps the user follow along.",
    "Do not ask for tools by any name except the tools provided to you.",
    "If a tool fails, recover by inspecting the error and trying a smaller next step.",
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

function sessionsDir(cwd: string): string {
  return path.join(gradientCodeDir(cwd), "sessions");
}

function configPath(cwd: string): string {
  return path.join(cwd, "gradient-code.config.json");
}

function makeSessionId(): string {
  return `session-${new Date().toISOString().replaceAll(":", "-")}`;
}

function makeRunId(): string {
  return `run-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergeTokenUsage(existing: TokenUsage | undefined, incoming: TokenUsage | undefined): TokenUsage | undefined {
  if (!existing && !incoming) {
    return undefined;
  }

  const next: TokenUsage = {
    inputTokens: (existing?.inputTokens ?? 0) + (incoming?.inputTokens ?? 0),
    outputTokens: (existing?.outputTokens ?? 0) + (incoming?.outputTokens ?? 0),
  };

  if (typeof existing?.totalTokens === "number" || typeof incoming?.totalTokens === "number") {
    next.totalTokens = (existing?.totalTokens ?? 0) + (incoming?.totalTokens ?? 0);
  } else if (typeof next.inputTokens === "number" && typeof next.outputTokens === "number") {
    next.totalTokens = next.inputTokens + next.outputTokens;
  }

  return next;
}

function truncateForModel(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} characters]`;
}

function formatToolResult(result: ToolResult): string {
  if (result.ok) {
    const summaryLines: string[] = [];

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

function buildFinalFallback(events: SessionEvent[], cwd: string): string {
  const recentToolResults = [...events]
    .reverse()
    .filter((event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result")
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason instanceof Error ? signal.reason.message : "Run cancelled.";
  const error = new Error(reason);
  error.name = "AbortError";
  throw error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

function validateValue(value: unknown, schema: JsonSchema, pathLabel: string): string[] {
  const errors: string[] = [];

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${pathLabel} must be an object`);
      return errors;
    }

    const record = value as Record<string, unknown>;
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

function validateToolInvocation(tool: Tool, input: Record<string, unknown>): ToolResult | null {
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

export async function loadGradientCodeConfig(cwd: string): Promise<GradientCodeConfig> {
  try {
    const raw = await fs.readFile(configPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as GradientCodeConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function saveGradientCodeConfig(cwd: string, config: GradientCodeConfig): Promise<string> {
  const filePath = configPath(cwd);
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export async function loadSession(cwd: string, sessionId: string): Promise<AgentSessionState | null> {
  try {
    const filePath = path.join(sessionsDir(cwd), `${sessionId}.json`);
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as AgentSessionState;
  } catch {
    return null;
  }
}

export async function deleteSession(cwd: string, sessionId: string): Promise<boolean> {
  try {
    const filePath = path.join(sessionsDir(cwd), `${sessionId}.json`);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadLatestSession(cwd: string): Promise<AgentSessionState | null> {
  try {
    const directory = sessionsDir(cwd);
    const entries = await fs.readdir(directory);
    const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
    if (jsonFiles.length === 0) {
      return null;
    }

    const latest = jsonFiles[jsonFiles.length - 1];
    const raw = await fs.readFile(path.join(directory, latest), "utf8");
    return JSON.parse(raw) as AgentSessionState;
  } catch {
    return null;
  }
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  try {
    const directory = sessionsDir(cwd);
    const entries = (await fs.readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .reverse();

    const sessions = await Promise.all(
      entries.map(async (entry) => {
        const raw = await fs.readFile(path.join(directory, entry), "utf8");
        const state = JSON.parse(raw) as AgentSessionState;
        const lastUserEvent = [...state.events].reverse().find((event) => event.type === "user");
        return {
          id: state.id,
          cwd: state.cwd,
          model: state.model,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          lastUserPrompt: lastUserEvent?.type === "user" ? lastUserEvent.text : "",
        } satisfies SessionSummary;
      }),
    );

    return sessions;
  } catch {
    return [];
  }
}

export async function saveSession(state: AgentSessionState): Promise<string> {
  const directory = sessionsDir(state.cwd);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${state.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return filePath;
}

export async function writeTranscript(cwd: string, events: SessionEvent[]): Promise<string> {
  const logDir = gradientCodeDir(cwd);
  await fs.mkdir(logDir, { recursive: true });
  const filePath = path.join(logDir, `session-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await fs.writeFile(filePath, JSON.stringify({ events }, null, 2), "utf8");
  return filePath;
}

export async function runAgent(
  options: AgentRunOptions,
  dependencies: RunAgentDependencies,
): Promise<AgentRunResult> {
  const maxTurns = options.maxTurns ?? 12;
  const policy = new SandboxPolicy();
  const runId = options.runId ?? makeRunId();
  const messages: AgentMessage[] = [...(options.initialMessages ?? []), { role: "user", content: options.userPrompt }];
  const events: SessionEvent[] = [
    ...(options.initialEvents ?? []),
    { type: "user", text: options.userPrompt, timestamp: timestamp(), runId },
  ];
  const sessionId = options.sessionId ?? makeSessionId();
  let previousResponseId: string | undefined;
  let finalText = "";
  let completedWithToolCalls = false;
  let usage: TokenUsage | undefined;
  let completedTurns = 0;

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    throwIfAborted(options.abortSignal);

    const request = {
      model: options.model,
      systemPrompt: options.systemPrompt,
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

    const toolCalls: ToolInvocation[] = turn.outputs
      .filter((output): output is Extract<typeof output, { type: "tool_call" }> => output.type === "tool_call")
      .map((output: Extract<typeof turn.outputs[number], { type: "tool_call" }>) => ({
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
        const missingResult: ToolResult = {
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
        ? ({
            ok: false,
            toolName: toolCall.name,
            error: {
              code: "POLICY_BLOCKED",
              message: policyDecision.reason ?? "Tool call blocked by sandbox policy",
            },
          } satisfies ToolResult)
        : validationResult
          ? validationResult
          : await withTimeout(
              tool.execute(toolCall.arguments, {
                cwd: options.cwd,
                previewEdits: options.previewEdits,
                approve: async (toolName: string, summary: string) => {
                  throwIfAborted(options.abortSignal);
                  const approvalTool = dependencies.toolRegistry.get("__approval__");
                  if (!approvalTool) {
                    return false;
                  }

                  const approvalResult = await approvalTool.execute(
                    { toolName, summary },
                    { cwd: options.cwd, previewEdits: options.previewEdits, approve: async () => false },
                  );
                  return approvalResult.ok && approvalResult.content === "approved";
                },
              }),
              options.toolTimeoutMs ?? 45_000,
              `Tool ${toolCall.name}`,
            ).catch((error) => ({
              ok: false,
              toolName: toolCall.name,
              error: {
                code: "TOOL_TIMEOUT",
                message: error instanceof Error ? error.message : "Tool timed out",
              },
            } satisfies ToolResult));

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
