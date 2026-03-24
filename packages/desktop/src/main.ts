import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import type {
  AgentSessionState,
  GradientCodeConfig,
  PromptPreset,
  SessionEvent,
  TokenUsage,
  Tool,
  ToolInvocation,
  ToolResult,
} from "@gradient-code/shared";
import {
  buildAgentSystemPrompt,
  deleteSession,
  loadProjectNotes,
  ToolRegistry,
  listSessions,
  loadGradientCodeConfig,
  loadLatestSession,
  loadSession,
  runAgent,
  saveGradientCodeConfig,
  saveSession,
  writeTranscript,
} from "@gradient-code/core";
import {
  AVAILABLE_GRADIENT_MODELS,
  GradientResponsesClient,
  resolveModelCapabilityProfile,
} from "@gradient-code/provider-gradient";
import { getDefaultTools } from "@gradient-code/tools";

type DesktopRunPayload = {
  cwd: string;
  prompt: string;
  model?: string;
  preset?: PromptPreset;
  approveAll?: boolean;
  store?: boolean;
  previewWrites?: boolean;
  maxTurns?: number;
  sessionId?: string;
  resumeLast?: boolean;
  providerTimeoutMs?: number;
  toolTimeoutMs?: number;
  retryCount?: number;
};

type BootstrapPayload = {
  cwd: string;
  config: GradientCodeConfig;
  sessions: Awaited<ReturnType<typeof listSessions>>;
  hasApiKey: boolean;
  modelOptions: Array<{
    id: string;
    label: string;
    family: string;
  }>;
};

type PendingApproval = {
  resolve: (approved: boolean) => void;
};

type RunProgressState = {
  runId: string;
  threadIndex: number;
  maxTurns: number;
  completedTurns: number;
  toolCalls: number;
  commandCalls: number;
  usage?: TokenUsage;
  phase: string;
  activeToolName?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appIconPath = path.resolve(__dirname, "../../../logo.png");
let mainWindow: BrowserWindow | null = null;
let activeRun = false;
let activeRunAbortController: AbortController | null = null;
const pendingApprovals = new Map<string, PendingApproval>();

function normalizeModelName(model: string): string {
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

function parseDotEnv(raw: string): void {
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

async function maybeLoadEnv(projectRoot: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const envPath = path.join(projectRoot, ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    parseDotEnv(raw);
  } catch {
    // Ignore missing files.
  }
}

function sendEvent(payload: Record<string, unknown>): void {
  mainWindow?.webContents.send("desktop:event", payload);
}

function isSafeExternalUrl(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function summarizeToolResult(result: ToolResult): string {
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

function isCommandToolName(toolName: string): boolean {
  return [
    "run_command",
    "start_command_session",
    "read_process_output",
    "send_process_input",
    "close_command_session",
  ].includes(toolName);
}

function mergeUsage(existing: TokenUsage | undefined, incoming: TokenUsage | undefined): TokenUsage | undefined {
  if (!existing && !incoming) {
    return undefined;
  }

  const merged: TokenUsage = {
    inputTokens: incoming?.inputTokens ?? existing?.inputTokens,
    outputTokens: incoming?.outputTokens ?? existing?.outputTokens,
    totalTokens: incoming?.totalTokens ?? existing?.totalTokens,
  };

  return merged;
}

function countExistingThreads(state: AgentSessionState | null): number {
  if (!state) {
    return 0;
  }

  const runIds = [...new Set(state.events.map((event) => event.runId).filter((runId): runId is string => Boolean(runId)))];
  if (runIds.length > 0) {
    return runIds.length;
  }

  return state.events.filter((event) => event.type === "user").length;
}

function makeRunId(): string {
  return `run-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function emitRunProgress(progress: RunProgressState): void {
  sendEvent({
    type: "run-progress",
    ...progress,
  });
}

function createApprovalTool(approveAll: boolean): Tool {
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
    async execute(inputArgs: Record<string, unknown>) {
      if (approveAll) {
        return { ok: true, toolName: this.name, content: "approved" };
      }

      const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sendEvent({
        type: "approval-request",
        requestId,
        toolName: String(inputArgs.toolName ?? "tool"),
        summary: String(inputArgs.summary ?? ""),
      });

      const approved = await new Promise<boolean>((resolve) => {
        pendingApprovals.set(requestId, { resolve });
      });

      return { ok: true, toolName: this.name, content: approved ? "approved" : "denied" };
    },
  };
}

async function getBootstrapPayload(cwd: string): Promise<BootstrapPayload> {
  const resolvedCwd = path.resolve(cwd);
  const stats = await fs.stat(resolvedCwd).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Workspace directory not found: ${resolvedCwd}`);
  }
  await maybeLoadEnv(resolvedCwd);
  return {
    cwd: resolvedCwd,
    config: await loadGradientCodeConfig(resolvedCwd),
    sessions: await listSessions(resolvedCwd),
    hasApiKey: Boolean(process.env.MODEL_ACCESS_KEY),
    modelOptions: AVAILABLE_GRADIENT_MODELS,
  };
}

async function createMainWindow(): Promise<void> {
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

ipcMain.handle("desktop:get-bootstrap", async (_event, cwd: string | undefined) => {
  return getBootstrapPayload(cwd ?? process.cwd());
});

ipcMain.handle("desktop:choose-workspace", async (_event, cwd: string | undefined) => {
  const defaultPath = path.resolve(cwd ?? process.cwd());
  const dialogOptions: OpenDialogOptions = {
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

ipcMain.handle("desktop:list-sessions", async (_event, cwd: string) => {
  return listSessions(path.resolve(cwd));
});

ipcMain.handle("desktop:load-session", async (_event, cwd: string, sessionId: string) => {
  return loadSession(path.resolve(cwd), sessionId);
});

ipcMain.handle("desktop:delete-session", async (_event, cwd: string, sessionId: string) => {
  const resolvedCwd = path.resolve(cwd);
  const deleted = await deleteSession(resolvedCwd, sessionId);
  return {
    deleted,
    sessions: await listSessions(resolvedCwd),
  };
});

ipcMain.handle("desktop:save-config", async (_event, cwd: string, config: GradientCodeConfig) => {
  return saveGradientCodeConfig(path.resolve(cwd), config);
});

ipcMain.handle("desktop:respond-approval", async (_event, requestId: string, approved: boolean) => {
  sendEvent({
    type: "debug-log",
    message: `desktop:respond-approval received requestId=${requestId} approved=${String(approved)}`,
  });
  const pending = pendingApprovals.get(requestId);
  if (pending) {
    pending.resolve(approved);
    pendingApprovals.delete(requestId);
    sendEvent({
      type: "debug-log",
      message: `desktop:respond-approval resolved requestId=${requestId}`,
    });
  } else {
    sendEvent({
      type: "debug-log",
      message: `desktop:respond-approval missing requestId=${requestId}`,
    });
  }
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

  return { ok: true, cancelled: true };
});

ipcMain.handle("desktop:start-run", async (_event, payload: DesktopRunPayload) => {
  if (activeRun) {
    throw new Error("A run is already in progress.");
  }

  activeRun = true;
  activeRunAbortController = new AbortController();
  const cwd = path.resolve(payload.cwd);
  const runId = makeRunId();
  let progress: RunProgressState | null = null;
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
    const resumed = payload.sessionId
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
    sendEvent({
      type: "debug-log",
      message: `Provider initialized baseUrl=${String(fileConfig.baseUrl ?? process.env.GRADIENT_BASE_URL ?? "default")} resumed=${String(Boolean(resumed))}`,
    });
    const toolRegistry = new ToolRegistry([...getDefaultTools(), createApprovalTool(approveAll)]);
    const projectNotes = await loadProjectNotes(cwd, fileConfig);
    const systemPrompt =
      resumed?.systemPrompt ??
      buildAgentSystemPrompt({
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

    const result = await runAgent(
      {
        model,
        cwd,
        userPrompt: payload.prompt,
        systemPrompt,
        storeResponses: store,
        previewEdits: previewWrites,
        maxTurns,
        initialMessages: resumed?.messages,
        initialEvents: resumed?.events,
        sessionId: resumed?.id,
        toolTimeoutMs,
        providerTimeoutMs,
        preset,
        abortSignal: activeRunAbortController.signal,
        runId,
      },
      {
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
        onToolCall: (toolCall: ToolInvocation) => {
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
        onToolResult: (toolCall: ToolInvocation, result: ToolResult) => {
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
      },
    );
    sendEvent({
      type: "debug-log",
      message: `runAgent resolved sessionId=${result.sessionId} finalTextLength=${result.finalText.length}`,
    });

    const createdAt = resumed?.createdAt ?? new Date().toISOString();
    const sessionState: AgentSessionState = {
      id: result.sessionId,
      cwd,
      model,
      systemPrompt,
      messages: result.messages,
      events: result.events,
      createdAt,
      updatedAt: new Date().toISOString(),
    };

    const sessionPath = await saveSession(sessionState);
    const transcriptPath = await writeTranscript(cwd, result.events);
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
      sessionId: result.sessionId,
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
  } catch (error) {
    const isCancelled =
      activeRunAbortController?.signal.aborted ||
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
  } finally {
    activeRun = false;
    activeRunAbortController = null;
  }
});

app.whenReady().then(async () => {
  try {
    await fs.access(appIconPath);
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(appIconPath));
    }
  } catch {
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
