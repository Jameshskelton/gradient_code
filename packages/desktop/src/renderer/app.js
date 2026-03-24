const COMMAND_TOOL_NAMES = new Set([
  "run_command",
  "start_command_session",
  "read_process_output",
  "send_process_input",
  "close_command_session",
]);

const PRESET_OPTIONS = [
  {
    id: "default",
    label: "Ask",
    hint: "General chat and code exploration.",
    placeholder: "Ask about the codebase, inspect files, or explain behavior.",
  },
  {
    id: "review",
    label: "Review",
    hint: "Focus on bugs, regressions, risky changes, and missing tests.",
    placeholder: "Review the current changes for bugs, regressions, and missing tests.",
  },
  {
    id: "plan",
    label: "Plan",
    hint: "Break work into phases, milestones, and risks.",
    placeholder: "Make a phased implementation plan for a feature, migration, or refactor.",
  },
  {
    id: "implement",
    label: "Implement",
    hint: "Inspect quickly, then move toward a concrete code change.",
    placeholder: "Describe the fix or feature you want implemented in this workspace.",
  },
  {
    id: "research",
    label: "Research",
    hint: "Compare options, gather references, and pull in outside context when needed.",
    placeholder: "Research an approach, compare libraries, or gather external references.",
  },
];
const PRESET_BY_ID = new Map(PRESET_OPTIONS.map((option) => [option.id, option]));

const DEBUG_EMPTY_TEXT = "Desktop event log will appear here.";
const COMMAND_LOG_EMPTY_TEXT = "Command activity will appear here.";
const RUN_DETAILS_COLLAPSED_KEY = "gradient-code:run-details-collapsed";

const state = {
  cwd: "",
  model: "",
  preset: "default",
  modelOptions: [],
  currentSessionId: null,
  running: false,
  approvals: [],
  sessions: [],
  waitingTimer: null,
  rightPaneWidth: 360,
  rightPaneCollapsed: false,
  runDetailsCollapsed: true,
  cancelRequested: false,
  commandEntries: [],
  progress: createDefaultProgressState(),
  threadContexts: new Map(),
  assistantStates: new Map(),
  runThreadMap: new Map(),
  pendingThreadId: null,
  currentRunId: null,
  nextThreadIndex: 1,
};

function createDefaultProgressState() {
  return {
    runId: null,
    threadIndex: null,
    model: "",
    maxTurns: 0,
    completedTurns: 0,
    toolCalls: 0,
    commandCalls: 0,
    usage: {},
    phase: "idle",
    activeToolName: "",
    statusMessage: "",
  };
}

function createDesktopApiFallback() {
  if (typeof window.require !== "function") {
    return null;
  }

  try {
    const { ipcRenderer } = window.require("electron");
    return {
      getBootstrap: (cwd) => ipcRenderer.invoke("desktop:get-bootstrap", cwd),
      chooseWorkspace: (cwd) => ipcRenderer.invoke("desktop:choose-workspace", cwd),
      listSessions: (cwd) => ipcRenderer.invoke("desktop:list-sessions", cwd),
      loadSession: (cwd, sessionId) => ipcRenderer.invoke("desktop:load-session", cwd, sessionId),
      deleteSession: (cwd, sessionId) => ipcRenderer.invoke("desktop:delete-session", cwd, sessionId),
      saveConfig: (cwd, config) => ipcRenderer.invoke("desktop:save-config", cwd, config),
      startRun: (payload) => ipcRenderer.invoke("desktop:start-run", payload),
      cancelRun: () => ipcRenderer.invoke("desktop:cancel-run"),
      respondApproval: (requestId, approved) => ipcRenderer.invoke("desktop:respond-approval", requestId, approved),
      onEvent: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("desktop:event", listener);
        return () => {
          ipcRenderer.removeListener("desktop:event", listener);
        };
      },
    };
  } catch {
    return null;
  }
}

const desktopApi = window.gradientCodeDesktop ?? createDesktopApiFallback();

const elements = {
  workspaceInput: document.getElementById("workspaceInput"),
  modelInput: document.getElementById("modelInput"),
  maxTurnsInput: document.getElementById("maxTurnsInput"),
  approveAllToggle: document.getElementById("approveAllToggle"),
  previewWritesToggle: document.getElementById("previewWritesToggle"),
  saveConfigButton: document.getElementById("saveConfigButton"),
  statusBar: document.getElementById("statusBar"),
  statusBarText: document.getElementById("statusBarText"),
  progressToggle: document.getElementById("progressToggle"),
  progressStrip: document.getElementById("progressStrip"),
  progressTitle: document.getElementById("progressTitle"),
  progressSubtitle: document.getElementById("progressSubtitle"),
  progressChips: document.getElementById("progressChips"),
  progressBarFill: document.getElementById("progressBarFill"),
  presetChips: document.getElementById("presetChips"),
  transcript: document.getElementById("transcript"),
  approvalModal: document.getElementById("approvalModal"),
  approvalModalSubtitle: document.getElementById("approvalModalSubtitle"),
  composerForm: document.getElementById("composerForm"),
  promptInput: document.getElementById("promptInput"),
  sendButton: document.getElementById("sendButton"),
  resumeButton: document.getElementById("resumeButton"),
  cancelButton: document.getElementById("cancelButton"),
  detailPaneToggle: document.getElementById("detailPaneToggle"),
  sessionList: document.getElementById("sessionList"),
  refreshSessionsButton: document.getElementById("refreshSessionsButton"),
  approvalList: document.getElementById("approvalList"),
  commandLogList: document.getElementById("commandLogList"),
  debugConsole: document.getElementById("debugConsole"),
  detailResizeHandle: document.getElementById("detailResizeHandle"),
};
let presetButtons = [];

const RIGHT_PANE_WIDTH_KEY = "gradient-code:right-pane-width";
const RIGHT_PANE_COLLAPSED_KEY = "gradient-code:right-pane-collapsed";
const MIN_RIGHT_PANE_WIDTH = 320;
const MAX_RIGHT_PANE_WIDTH = 720;

function setStatus(text) {
  elements.statusBarText.textContent = text;
}

function normalizePreset(value) {
  return PRESET_BY_ID.has(value) ? value : "default";
}

function renderPresetButtons() {
  elements.presetChips.textContent = "";
  presetButtons = PRESET_OPTIONS.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-chip";
    button.dataset.preset = option.id;
    button.setAttribute("aria-pressed", "false");

    button.textContent = option.label;
    button.addEventListener("click", () => {
      setPreset(option.id);
    });
    elements.presetChips.append(button);
    return button;
  });
}

function setPreset(preset) {
  const normalized = normalizePreset(preset);
  state.preset = normalized;
  const config = PRESET_BY_ID.get(normalized) ?? PRESET_BY_ID.get("default");

  for (const button of presetButtons) {
    const isActive = button.dataset.preset === normalized;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  if (config) {
    elements.promptInput.placeholder = config.placeholder;
    elements.presetChips.dataset.activePreset = config.id;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyRightPaneWidth(width) {
  const clampedWidth = clamp(width, MIN_RIGHT_PANE_WIDTH, Math.min(MAX_RIGHT_PANE_WIDTH, window.innerWidth - 420));
  state.rightPaneWidth = clampedWidth;
  document.documentElement.style.setProperty("--right-pane-width", `${clampedWidth}px`);
}

function applyRightPaneCollapsed(collapsed) {
  state.rightPaneCollapsed = Boolean(collapsed);
  document.body.classList.toggle("detail-pane-collapsed", state.rightPaneCollapsed);
  elements.detailPaneToggle.setAttribute("aria-expanded", String(!state.rightPaneCollapsed));
  elements.detailPaneToggle.setAttribute(
    "aria-label",
    state.rightPaneCollapsed ? "Open right sidebar" : "Collapse right sidebar",
  );
  elements.detailPaneToggle.title = state.rightPaneCollapsed
    ? "Open command log and debug sidebar"
    : "Collapse command log and debug sidebar";
  elements.detailPaneToggle.querySelector(".detail-pane-toggle-icon").textContent = state.rightPaneCollapsed ? "<" : ">";
}

function loadPaneWidthPreference() {
  const raw = window.localStorage.getItem(RIGHT_PANE_WIDTH_KEY);
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isFinite(parsed)) {
    applyRightPaneWidth(parsed);
  }
}

function loadPaneCollapsedPreference() {
  const raw = window.localStorage.getItem(RIGHT_PANE_COLLAPSED_KEY);
  applyRightPaneCollapsed(raw === "true");
}

function savePaneWidthPreference() {
  window.localStorage.setItem(RIGHT_PANE_WIDTH_KEY, String(state.rightPaneWidth));
}

function savePaneCollapsedPreference() {
  window.localStorage.setItem(RIGHT_PANE_COLLAPSED_KEY, String(state.rightPaneCollapsed));
}

function applyRunDetailsCollapsed(collapsed) {
  state.runDetailsCollapsed = Boolean(collapsed);
  elements.progressToggle.setAttribute("aria-expanded", String(!state.runDetailsCollapsed));
  elements.progressToggle.textContent = state.runDetailsCollapsed ? "Show details" : "Hide details";
}

function loadRunDetailsPreference() {
  const raw = window.localStorage.getItem(RUN_DETAILS_COLLAPSED_KEY);
  applyRunDetailsCollapsed(raw === null ? true : raw === "true");
}

function saveRunDetailsPreference() {
  window.localStorage.setItem(RUN_DETAILS_COLLAPSED_KEY, String(state.runDetailsCollapsed));
}

function toggleRunDetails() {
  applyRunDetailsCollapsed(!state.runDetailsCollapsed);
  saveRunDetailsPreference();
  renderProgress();
}

function initializeResizeHandle() {
  if (!elements.detailResizeHandle) {
    return;
  }

  elements.detailResizeHandle.addEventListener("pointerdown", (event) => {
    if (state.rightPaneCollapsed) {
      return;
    }
    event.preventDefault();
    document.body.classList.add("resizing");

    const onPointerMove = (moveEvent) => {
      const nextWidth = window.innerWidth - moveEvent.clientX;
      applyRightPaneWidth(nextWidth);
    };

    const onPointerUp = () => {
      document.body.classList.remove("resizing");
      savePaneWidthPreference();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
}

function toggleRightPane() {
  applyRightPaneCollapsed(!state.rightPaneCollapsed);
  savePaneCollapsedPreference();
}

function appendDebug(message) {
  const timestamp = new Date().toLocaleTimeString();
  const nextLine = `[${timestamp}] ${message}`;
  if (elements.debugConsole.textContent === DEBUG_EMPTY_TEXT) {
    elements.debugConsole.textContent = nextLine;
  } else {
    elements.debugConsole.textContent += `\n${nextLine}`;
  }
  elements.debugConsole.scrollTop = elements.debugConsole.scrollHeight;
}

appendDebug(`desktopApi:${desktopApi ? "available" : "missing"}`);

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function setRunning(running) {
  state.running = running;
  elements.sendButton.disabled = running;
  elements.resumeButton.disabled = running;
  elements.cancelButton.disabled = !running;
  for (const button of presetButtons) {
    button.disabled = running;
  }
  if (!running && state.waitingTimer) {
    clearTimeout(state.waitingTimer);
    state.waitingTimer = null;
  }
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatWorkspaceLabel(value) {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized) {
    return "workspace";
  }

  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function lineCountForElement(element) {
  const computedStyle = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return 1;
  }

  return Math.max(1, Math.round(element.getBoundingClientRect().height / lineHeight));
}

function fitSessionCardText(card) {
  if (!card) {
    return;
  }

  const title = card.querySelector("strong");
  const meta = [...card.querySelectorAll("span")];
  if (!title) {
    return;
  }

  const maxTitleSize = 18;
  const minTitleSize = 12;
  const maxMetaSize = 13;
  const minMetaSize = 10;
  let titleSize = maxTitleSize;
  let metaSize = maxMetaSize;

  card.style.setProperty("--session-title-size", `${titleSize}px`);
  card.style.setProperty("--session-meta-size", `${metaSize}px`);

  for (let index = 0; index < 12; index += 1) {
    const titleLines = lineCountForElement(title);
    const metaTooTall = meta.some((item) => lineCountForElement(item) > 2);
    const titleTooTall = titleLines > 5;
    const contentTooTall = card.getBoundingClientRect().height > 190;

    if (!titleTooTall && !metaTooTall && !contentTooTall) {
      break;
    }

    if (titleTooTall || contentTooTall) {
      titleSize = Math.max(minTitleSize, titleSize - 1);
    }

    if (metaTooTall || contentTooTall) {
      metaSize = Math.max(minMetaSize, metaSize - 0.5);
    }

    card.style.setProperty("--session-title-size", `${titleSize}px`);
    card.style.setProperty("--session-meta-size", `${metaSize}px`);

    if (titleSize === minTitleSize && metaSize === minMetaSize) {
      break;
    }
  }
}

function fitAllSessionCards() {
  elements.sessionList.querySelectorAll(".session-item").forEach((card) => {
    fitSessionCardText(card);
  });
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function renderMarkdown(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const html = [];
  let paragraphLines = [];
  let listItems = [];
  let listType = null;
  let codeFence = null;
  let codeLines = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) {
      return;
    }
    html.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "))}</p>`);
    paragraphLines = [];
  }

  function flushList() {
    if (listItems.length === 0) {
      return;
    }
    const tagName = listType === "ol" ? "ol" : "ul";
    html.push(`<${tagName}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tagName}>`);
    listItems = [];
    listType = null;
  }

  function flushCodeBlock() {
    if (codeFence === null) {
      return;
    }
    const className = codeFence ? ` class="language-${escapeHtml(codeFence)}"` : "";
    html.push(`<pre><code${className}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeFence = null;
    codeLines = [];
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      if (codeFence !== null) {
        flushCodeBlock();
      } else {
        codeFence = fenceMatch[1] || "";
        codeLines = [];
      }
      continue;
    }

    if (codeFence !== null) {
      codeLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const unorderedListMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (unorderedListMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(unorderedListMatch[1]);
      continue;
    }

    const orderedListMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (orderedListMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(orderedListMatch[1]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCodeBlock();

  return html.join("");
}

function setBubbleContent(bubble, role, text) {
  if (role === "assistant" || role === "system") {
    bubble.body.innerHTML = renderMarkdown(text);
  } else {
    bubble.body.textContent = text;
  }
}

function createEmptyState(target, text) {
  target.classList.add("empty-state");
  target.textContent = text;
}

function clearEmptyState(target) {
  target.classList.remove("empty-state");
  target.textContent = "";
}

function resetLogPanels() {
  state.commandEntries = [];
  createEmptyState(elements.commandLogList, COMMAND_LOG_EMPTY_TEXT);
}

function createThreadContext({ threadId, title, subtitle, status, statusTone }) {
  const section = document.createElement("section");
  section.className = "thread-section";
  section.dataset.threadId = threadId;

  const header = document.createElement("div");
  header.className = "thread-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "thread-title-group";

  const titleElement = document.createElement("h3");
  titleElement.className = "thread-title";
  titleElement.textContent = title;

  const metaElement = document.createElement("div");
  metaElement.className = "thread-meta";
  metaElement.textContent = subtitle;

  const statusElement = document.createElement("div");
  statusElement.className = "thread-status";
  statusElement.textContent = status;
  if (statusTone) {
    statusElement.classList.add(statusTone);
  }

  titleGroup.append(titleElement, metaElement);
  header.append(titleGroup, statusElement);

  const body = document.createElement("div");
  body.className = "thread-body";

  section.append(header, body);
  elements.transcript.append(section);

  const context = {
    threadId,
    section,
    body,
    titleElement,
    metaElement,
    statusElement,
    currentActivityBlock: null,
  };

  state.threadContexts.set(threadId, context);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return context;
}

function ensureThreadContext(threadId, fallback) {
  const existing = state.threadContexts.get(threadId);
  if (existing) {
    return existing;
  }

  return createThreadContext({
    threadId,
    title: fallback?.title ?? `Conversation ${state.nextThreadIndex}`,
    subtitle: fallback?.subtitle ?? "Session thread",
    status: fallback?.status ?? "Loaded",
    statusTone: fallback?.statusTone ?? "",
  });
}

function updateThreadContext(threadId, patch) {
  const context = state.threadContexts.get(threadId);
  if (!context) {
    return;
  }

  if (patch.title) {
    context.titleElement.textContent = patch.title;
  }
  if (patch.subtitle) {
    context.metaElement.textContent = patch.subtitle;
  }
  if (patch.status) {
    context.statusElement.textContent = patch.status;
  }
  context.statusElement.className = "thread-status";
  if (patch.statusTone) {
    context.statusElement.classList.add(patch.statusTone);
  }
}

function createThreadTitle(threadIndex, prompt) {
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    return `Conversation ${threadIndex}`;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  if (firstLine.length <= 72) {
    return firstLine;
  }

  return `${firstLine.slice(0, 69)}...`;
}

function startNewThread(prompt, options = {}) {
  const threadIndex = options.threadIndex ?? state.nextThreadIndex;
  state.nextThreadIndex = Math.max(state.nextThreadIndex, threadIndex + 1);
  const threadId = options.threadId ?? `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = options.title ?? createThreadTitle(threadIndex, prompt);
  const subtitle = options.subtitle ?? "Preparing run...";
  createThreadContext({
    threadId,
    title,
    subtitle,
    status: options.status ?? "Queued",
    statusTone: options.statusTone ?? "",
  });
  state.pendingThreadId = threadId;
  return threadId;
}

function getAssistantState(threadId) {
  const existing = state.assistantStates.get(threadId);
  if (existing) {
    return existing;
  }

  const next = {
    bubble: null,
    renderedText: "",
    visibleText: "",
    turnText: "",
  };
  state.assistantStates.set(threadId, next);
  return next;
}

function finalizeInlineActivityBlock(threadId) {
  const context = state.threadContexts.get(threadId);
  if (!context?.currentActivityBlock) {
    return;
  }

  context.currentActivityBlock.root.open = false;
  context.currentActivityBlock = null;
}

function createBubble(role, text, threadId) {
  const context = ensureThreadContext(threadId, {
    title: `Conversation ${state.nextThreadIndex}`,
    subtitle: "Session thread",
    status: "Loaded",
  });
  finalizeInlineActivityBlock(threadId);

  const wrapper = document.createElement("div");
  wrapper.className = `bubble ${role}`;
  const label = document.createElement("div");
  label.className = "bubble-label";
  label.textContent = role === "assistant" ? "Assistant" : role === "user" ? "You" : "System";
  const body = document.createElement("div");
  body.className = "bubble-body";
  setBubbleContent({ body }, role, text);
  wrapper.append(label, body);
  context.body.append(wrapper);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return { wrapper, body, role };
}

function mergeAssistantText(existingText, nextText) {
  const existing = String(existingText || "");
  const next = String(nextText || "");

  if (!existing.trim()) {
    return next;
  }

  if (!next.trim()) {
    return existing;
  }

  if (next.startsWith(existing)) {
    return next;
  }

  if (existing.startsWith(next)) {
    return existing;
  }

  const normalizedExisting = existing.trim();
  const normalizedNext = next.trim();

  if (normalizedNext.includes(normalizedExisting)) {
    return next;
  }

  if (normalizedExisting.includes(normalizedNext)) {
    return existing;
  }

  const maxOverlap = Math.min(existing.length, next.length);
  for (let overlap = maxOverlap; overlap >= 24; overlap -= 1) {
    if (existing.slice(-overlap) === next.slice(0, overlap)) {
      return `${existing}${next.slice(overlap)}`;
    }
  }

  return `${existing}\n\n${next}`;
}

function isAssistantExtension(existingText, nextText) {
  const existing = String(existingText || "");
  const next = String(nextText || "");

  if (!existing.trim()) {
    return true;
  }

  if (!next.trim()) {
    return false;
  }

  if (next.startsWith(existing) || existing.startsWith(next)) {
    return true;
  }

  const normalizedExisting = existing.trim();
  const normalizedNext = next.trim();

  if (normalizedNext.includes(normalizedExisting) || normalizedExisting.includes(normalizedNext)) {
    return true;
  }

  const maxOverlap = Math.min(existing.length, next.length);
  for (let overlap = maxOverlap; overlap >= 24; overlap -= 1) {
    if (existing.slice(-overlap) === next.slice(0, overlap)) {
      return true;
    }
  }

  return false;
}

function appendAssistantEvent(threadId, text) {
  if (!String(text || "").trim()) {
    return;
  }

  const assistantState = getAssistantState(threadId);
  if (assistantState.bubble && isAssistantExtension(assistantState.renderedText, text)) {
    const merged = mergeAssistantText(assistantState.renderedText, text);
    setBubbleContent(assistantState.bubble, "assistant", merged);
    assistantState.renderedText = merged;
    assistantState.visibleText = merged;
    return;
  }

  assistantState.bubble = createBubble("assistant", text, threadId);
  assistantState.renderedText = String(text);
  assistantState.visibleText = String(text);
  assistantState.turnText = "";
}

function buildActivitySummaryItem(entry) {
  const item = document.createElement("div");
  item.className = "activity-summary-item";

  const header = document.createElement("div");
  header.className = "activity-summary-item-header";

  const title = document.createElement("strong");
  title.textContent = entry.summary || entry.title;

  const status = document.createElement("div");
  status.className = "panel-entry-status";
  const tone = pickEntryTone(entry.status);
  if (tone) {
    status.classList.add(tone);
  }
  status.textContent = entry.statusLabel;

  header.append(title, status);
  item.append(header);

  if (entry.summary && entry.summary !== entry.title) {
    const toolName = document.createElement("div");
    toolName.className = "activity-summary-tool";
    toolName.textContent = entry.title;
    item.append(toolName);
  }

  if (entry.detail) {
    const disclosure = document.createElement("details");
    disclosure.className = "activity-summary-disclosure";
    if (entry.status === "failed") {
      disclosure.open = true;
    }

    const disclosureSummary = document.createElement("summary");
    disclosureSummary.className = "activity-summary-disclosure-toggle";
    disclosureSummary.textContent = "Raw output";

    const detail = document.createElement("pre");
    detail.className = "activity-summary-detail";
    detail.textContent = entry.detail;

    disclosure.append(disclosureSummary, detail);
    item.append(disclosure);
  }

  if (entry.diff) {
    const disclosure = document.createElement("details");
    disclosure.className = "activity-summary-disclosure";

    const disclosureSummary = document.createElement("summary");
    disclosureSummary.className = "activity-summary-disclosure-toggle";
    disclosureSummary.textContent = "Diff preview";

    const diff = document.createElement("pre");
    diff.className = "activity-summary-diff";
    diff.textContent = entry.diff;

    disclosure.append(disclosureSummary, diff);
    item.append(disclosure);
  }

  return item;
}

function summarizeActivityEntries(entries) {
  const values = [...entries.values()];
  const completed = values.filter((entry) => entry.status === "completed").length;
  const failed = values.filter((entry) => entry.status === "failed").length;
  const info = values.filter((entry) => entry.status === "info").length;
  const pending = values.filter((entry) => entry.status === "pending").length;
  const parts = [`${values.length} step${values.length === 1 ? "" : "s"}`];

  if (completed > 0) {
    parts.push(`${completed} completed`);
  }
  if (pending > 0) {
    parts.push(`${pending} pending`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (info > 0) {
    parts.push(`${info} info`);
  }

  return parts.join(" • ");
}

function renderInlineActivityBlock(block) {
  block.body.textContent = "";
  for (const entry of block.entries.values()) {
    block.body.append(buildActivitySummaryItem(entry));
  }
  block.meta.textContent = summarizeActivityEntries(block.entries);
}

function createInlineActivityBlock(threadId) {
  const context = ensureThreadContext(threadId, {
    title: `Conversation ${state.nextThreadIndex}`,
    subtitle: "Session thread",
    status: "Loaded",
  });

  const details = document.createElement("details");
  details.className = "activity-summary";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "activity-summary-toggle";

  const title = document.createElement("span");
  title.className = "activity-summary-title";
  title.textContent = "Activity summary";

  const meta = document.createElement("span");
  meta.className = "activity-summary-meta";
  meta.textContent = "Waiting for tool results...";

  summary.append(title, meta);

  const body = document.createElement("div");
  body.className = "activity-summary-list";

  details.append(summary, body);
  context.body.append(details);

  const block = {
    root: details,
    meta,
    body,
    entries: new Map(),
  };

  context.currentActivityBlock = block;
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return block;
}

function getInlineActivityBlock(threadId) {
  const context = ensureThreadContext(threadId, {
    title: `Conversation ${state.nextThreadIndex}`,
    subtitle: "Session thread",
    status: "Loaded",
  });

  if (context.currentActivityBlock) {
    return context.currentActivityBlock;
  }

  return createInlineActivityBlock(threadId);
}

function upsertInlineActivityEntry(threadId, nextEntry) {
  const block = getInlineActivityBlock(threadId);
  const existing = block.entries.get(nextEntry.id);
  block.entries.set(nextEntry.id, existing ? { ...existing, ...nextEntry } : nextEntry);
  renderInlineActivityBlock(block);
}

function commitAssistantText(assistantState, text) {
  const nextText = String(text || "");
  if (!nextText.trim()) {
    return;
  }

  if (!assistantState.bubble) {
    return;
  }

  setBubbleContent(assistantState.bubble, "assistant", nextText);
  assistantState.renderedText = nextText;
  assistantState.visibleText = nextText;
}

function chooseMoreCompleteAssistantText(existingText, nextText) {
  const existing = String(existingText || "");
  const next = String(nextText || "");

  if (!next.trim()) {
    return existing;
  }

  if (!existing.trim()) {
    return next;
  }

  if (isAssistantExtension(existing, next)) {
    return mergeAssistantText(existing, next);
  }

  return next.length >= existing.length ? next : existing;
}

function getAuthoritativeAssistantText(payload) {
  const finalText = typeof payload.finalText === "string" ? payload.finalText : "";
  const events = Array.isArray(payload.events) ? payload.events : [];

  const eventText = [...events]
    .reverse()
    .find((event) => event?.type === "assistant" && (!payload.runId || event.runId === payload.runId))?.text;

  return chooseMoreCompleteAssistantText(finalText, typeof eventText === "string" ? eventText : "");
}

function summarizeArguments(toolName, inputArgs) {
  if (COMMAND_TOOL_NAMES.has(toolName)) {
    if (typeof inputArgs.command === "string") {
      return inputArgs.command;
    }

    if (typeof inputArgs.session_id === "string" && typeof inputArgs.input === "string") {
      return `${inputArgs.session_id}: ${inputArgs.input}`;
    }

    if (typeof inputArgs.session_id === "string") {
      return inputArgs.session_id;
    }
  }

  try {
    const serialized = JSON.stringify(inputArgs, null, 2);
    return serialized.length > 360 ? `${serialized.slice(0, 357)}...` : serialized;
  } catch {
    return String(inputArgs ?? "");
  }
}

function lastPathSegment(value) {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized) {
    return "file";
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizePendingTool(toolName, inputArgs) {
  switch (toolName) {
    case "git_status":
      return "Checking git status";
    case "git_changed_files":
      return "Collecting changed files";
    case "git_changed_file_summaries":
      return "Summarizing changed files";
    case "estimate_test_impact":
      return "Estimating test impact";
    case "list_files":
      return "Scanning workspace files";
    case "list_tree":
      return "Inspecting the workspace tree";
    case "read_file":
      return `Reading ${lastPathSegment(inputArgs.path)}`;
    case "read_many_files":
      return "Reading selected files";
    case "find_symbol":
      return `Looking for ${String(inputArgs.query ?? "").trim() || "symbols"}`;
    case "find_references":
      return `Looking for references to ${String(inputArgs.symbol ?? "").trim() || "a symbol"}`;
    case "list_exports":
      return `Listing exports in ${lastPathSegment(inputArgs.path)}`;
    case "list_imports":
      return `Listing imports in ${lastPathSegment(inputArgs.path)}`;
    case "search_text":
      return `Searching for ${String(inputArgs.query ?? "").trim() || "text"}`;
    case "inspect_path":
      return `Inspecting ${lastPathSegment(inputArgs.path)}`;
    case "get_cwd":
      return "Checking the current workspace";
    default:
      return summarizeArguments(toolName, inputArgs);
  }
}

function summarizeNonCommandTool(toolName, result, fallbackSummary) {
  const safeFallback = typeof fallbackSummary === "string" ? fallbackSummary.trim() : "";

  if (result?.metadata?.gitRepo === false) {
    switch (toolName) {
      case "git_status":
        return "Found no git repository";
      case "git_changed_files":
        return "No git change list is available";
      case "git_changed_file_summaries":
        return "No git diff summaries are available";
      case "git_diff":
        return "No git diff is available";
      case "git_recent_commits":
        return "No git history is available";
      case "estimate_test_impact":
        return "No git change set is available for test impact";
      default:
        return "Git history is not available in this workspace";
    }
  }

  if (!result?.ok) {
    if (result?.error?.code === "NOT_A_GIT_REPO") {
      return "Found no git repository";
    }
    if (result?.error?.code === "NOT_FOUND") {
      return safeFallback || "Found no matching results";
    }
    return safeFallback || result?.error?.message || "Tool step failed";
  }

  const metadata = result.metadata || {};
  const returned = typeof metadata.returned === "number" ? metadata.returned : undefined;
  const count = typeof metadata.count === "number" ? metadata.count : returned;

  switch (toolName) {
    case "git_status":
      return result.content.includes("Working tree clean") ? "Checked git status; working tree is clean" : "Checked git status";
    case "git_changed_files":
      return count === 0 ? "Found no changed files" : `Found ${pluralize(count ?? 0, "changed file")}`;
    case "git_changed_file_summaries":
      return count === 0 ? "Found no changed files to summarize" : `Summarized ${pluralize(returned ?? count ?? 0, "changed file")}`;
    case "estimate_test_impact":
      return typeof metadata.riskLevel === "string" ? `Estimated ${metadata.riskLevel} test risk` : "Estimated test impact";
    case "list_files":
      return count === 0 ? "Found no files" : `Inspected ${pluralize(returned ?? count ?? 0, "file")}`;
    case "list_tree":
      return count === 0 ? "Found no workspace entries" : `Inspected ${pluralize(returned ?? count ?? 0, "workspace entry")}`;
    case "read_file":
      return `Read ${lastPathSegment(metadata.path)}`;
    case "read_many_files":
      return count === 0 ? "Read no files" : `Read ${pluralize(returned ?? count ?? 0, "file")}`;
    case "find_symbol":
      return count === 0 ? "Found no matching symbols" : `Found ${pluralize(count ?? 0, "matching symbol")}`;
    case "find_references":
      return count === 0 ? "Found no references" : `Found ${pluralize(count ?? 0, "reference")}`;
    case "list_exports":
      return count === 0 ? "Found no exports" : `Listed ${pluralize(count ?? 0, "export")}`;
    case "list_imports":
      return count === 0 ? "Found no imports" : `Listed ${pluralize(count ?? 0, "import")}`;
    case "search_text":
      return result.content.includes("No matches found") ? "Found no text matches" : "Found text matches";
    case "inspect_path":
      return `Inspected ${lastPathSegment(metadata.path)}`;
    case "get_cwd":
      return "Checked the current workspace";
    default:
      break;
  }

  if (Array.isArray(metadata.files)) {
    const fileCount = returned ?? count ?? metadata.files.length;
    return `Inspected ${pluralize(fileCount, "file")}`;
  }

  if (typeof metadata.path === "string") {
    return metadata.changed === true ? `Updated ${lastPathSegment(metadata.path)}` : `Checked ${lastPathSegment(metadata.path)}`;
  }

  if (safeFallback) {
    return safeFallback;
  }

  return truncateText(result.content, 120) || "Completed";
}

function isInformationalToolResult(result) {
  return result?.metadata?.informational === true || result?.metadata?.gitRepo === false || result?.error?.code === "NOT_A_GIT_REPO";
}

function truncateText(text, maxLength = 480) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function pickEntryTone(status) {
  if (status === "failed" || status === "error") {
    return "is-error";
  }
  if (status === "completed") {
    return "is-success";
  }
  if (status === "info") {
    return "is-info";
  }
  if (status === "pending" || status === "running") {
    return "is-warning";
  }
  return "";
}

function buildPanelEntryCard(entry) {
  const card = document.createElement("div");
  card.className = "panel-entry";

  const header = document.createElement("div");
  header.className = "panel-entry-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "panel-entry-title";

  const title = document.createElement("strong");
  title.textContent = entry.title;

  const meta = document.createElement("div");
  meta.className = "panel-entry-meta";
  meta.textContent = entry.meta;

  titleWrap.append(title, meta);

  const status = document.createElement("div");
  status.className = "panel-entry-status";
  const tone = pickEntryTone(entry.status);
  if (tone) {
    status.classList.add(tone);
  }
  status.textContent = entry.statusLabel;

  header.append(titleWrap, status);
  card.append(header);

  if (entry.summary) {
    const summary = document.createElement("div");
    summary.className = "panel-entry-summary";
    summary.textContent = entry.summary;
    card.append(summary);
  }

  if (entry.detail) {
    const detail = document.createElement("pre");
    detail.className = "panel-entry-detail";
    detail.textContent = entry.detail;
    card.append(detail);
  }

  if (entry.diff) {
    const diff = document.createElement("pre");
    diff.className = "panel-entry-diff";
    diff.textContent = entry.diff;
    card.append(diff);
  }

  return card;
}

function renderCommandLogEntries() {
  const target = elements.commandLogList;
  if (state.commandEntries.length === 0) {
    createEmptyState(target, COMMAND_LOG_EMPTY_TEXT);
    return;
  }

  target.textContent = "";
  clearEmptyState(target);
  for (const entry of state.commandEntries) {
    target.append(buildPanelEntryCard(entry));
  }
}

function upsertCommandLogEntry(nextEntry) {
  const list = state.commandEntries;
  const index = list.findIndex((entry) => entry.id === nextEntry.id);
  if (index === -1) {
    list.unshift(nextEntry);
  } else {
    list[index] = {
      ...list[index],
      ...nextEntry,
    };
  }
  renderCommandLogEntries();
}

function createPendingToolEntry(payload) {
  const toolCall = payload.toolCall;
  return {
    id: toolCall.callId,
    title: toolCall.name,
    meta: `Started ${formatTime(new Date().toISOString())}`,
    status: "pending",
    statusLabel: "Pending",
    summary: summarizePendingTool(toolCall.name, toolCall.arguments || {}),
    detail: "",
    diff: "",
  };
}

function createFinishedToolEntry(payload) {
  const toolCall = payload.toolCall;
  const result = payload.result;
  const detailParts = [];

  if (typeof result?.content === "string" && result.content.trim()) {
    detailParts.push(truncateText(result.content, COMMAND_TOOL_NAMES.has(toolCall.name) ? 900 : 420));
  }

  if (!result?.ok && result?.error?.message) {
    detailParts.push(result.error.message);
  }

  const diff = typeof result?.metadata?.diff === "string" ? result.metadata.diff : "";

  return {
    id: toolCall.callId,
    title: toolCall.name,
    meta: `Completed ${formatTime(new Date().toISOString())}`,
    status: isInformationalToolResult(result) ? "info" : result?.ok ? "completed" : "failed",
    statusLabel: isInformationalToolResult(result) ? "Info" : result?.ok ? "Completed" : "Failed",
    summary: COMMAND_TOOL_NAMES.has(toolCall.name)
      ? payload.summary || summarizeArguments(toolCall.name, toolCall.arguments || {})
      : summarizeNonCommandTool(toolCall.name, result, payload.summary),
    detail: detailParts.filter(Boolean).join("\n\n"),
    diff,
  };
}

function renderApprovals() {
  if (state.approvals.length === 0) {
    elements.approvalList.className = "approval-list approval-modal-list empty-state";
    elements.approvalList.textContent = "No pending approvals.";
    elements.approvalModal.classList.add("hidden");
    elements.approvalModal.setAttribute("aria-hidden", "true");
    return;
  }

  elements.approvalList.className = "approval-list approval-modal-list";
  elements.approvalList.textContent = "";
  elements.approvalModal.classList.remove("hidden");
  elements.approvalModal.setAttribute("aria-hidden", "false");
  elements.approvalModalSubtitle.textContent =
    state.approvals.length === 1
      ? "One action is waiting for your approval."
      : `${state.approvals.length} actions are waiting for your approval.`;

  for (const approval of state.approvals) {
    const card = document.createElement("div");
    card.className = "approval-card";

    const title = document.createElement("h3");
    title.textContent = approval.toolName;
    card.append(title);

    const { requestText, diffText } = splitApprovalSummary(approval.summary);

    if (diffText) {
      const diffSection = document.createElement("div");
      diffSection.className = "approval-section";

      const diffLabel = document.createElement("div");
      diffLabel.className = "approval-label";
      diffLabel.textContent = "Diff Preview";

      const diff = document.createElement("pre");
      diff.className = "approval-diff";
      diff.textContent = diffText;

      diffSection.append(diffLabel, diff);
      card.append(diffSection);
    }

    if (requestText) {
      const summarySection = document.createElement("div");
      summarySection.className = "approval-section";

      const summaryLabel = document.createElement("div");
      summaryLabel.className = "approval-label";
      summaryLabel.textContent = diffText ? "Request Details" : "Request";

      const summary = document.createElement("pre");
      summary.className = "approval-summary";
      summary.textContent = requestText;

      summarySection.append(summaryLabel, summary);
      card.append(summarySection);
    }

    const actions = document.createElement("div");
    actions.className = "approval-actions";

    const approveButton = document.createElement("button");
    approveButton.className = "solid-button";
    approveButton.textContent = "Approve";
    approveButton.addEventListener("click", async () => {
      appendDebug(`approval:click approve requestId=${approval.requestId}`);
      if (!desktopApi) {
        setStatus("Desktop IPC bridge is unavailable.");
        appendDebug("approval:error desktopApi missing");
        return;
      }
      await desktopApi.respondApproval(approval.requestId, true);
      state.approvals = state.approvals.filter((item) => item.requestId !== approval.requestId);
      renderApprovals();
      updateProgress({
        phase: "running-tools",
        activeToolName: approval.toolName,
      });
      setStatus(`Approved ${approval.toolName}. Waiting for run to continue...`);
    });

    const denyButton = document.createElement("button");
    denyButton.className = "ghost-button";
    denyButton.textContent = "Deny";
    denyButton.addEventListener("click", async () => {
      appendDebug(`approval:click deny requestId=${approval.requestId}`);
      if (!desktopApi) {
        setStatus("Desktop IPC bridge is unavailable.");
        appendDebug("approval:error desktopApi missing");
        return;
      }
      await desktopApi.respondApproval(approval.requestId, false);
      state.approvals = state.approvals.filter((item) => item.requestId !== approval.requestId);
      renderApprovals();
      updateProgress({
        phase: "tool-error",
        activeToolName: approval.toolName,
      });
      setStatus(`Denied ${approval.toolName}. Waiting for run to continue...`);
    });

    actions.append(approveButton, denyButton);
    card.append(actions);
    elements.approvalList.append(card);
  }
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

function renderSessions() {
  elements.sessionList.textContent = "";

  if (state.sessions.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-session";
    emptyState.textContent = "No saved sessions yet.";
    elements.sessionList.append(emptyState);
    return;
  }

  for (const session of state.sessions) {
    const card = document.createElement("article");
    card.className = `session-item ${state.currentSessionId === session.id ? "active" : ""}`;

    const header = document.createElement("div");
    header.className = "session-item-header";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete-button";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = state.running;
    deleteButton.setAttribute("aria-label", `Delete session: ${session.lastUserPrompt || "Untitled session"}`);
    deleteButton.title = state.running ? "Wait for the current run to finish before deleting sessions." : "Delete session";
    deleteButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deleteSessionFromUi(session);
    });

    header.append(deleteButton);

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-open-button";
    const title = document.createElement("strong");
    title.textContent = session.lastUserPrompt || "Untitled session";
    const model = document.createElement("span");
    model.textContent = session.model;
    const updated = document.createElement("span");
    updated.textContent = formatTime(session.updatedAt);
    openButton.append(title, model, updated);
    openButton.addEventListener("click", async () => {
      if (!desktopApi) {
        setStatus("Desktop IPC bridge is unavailable.");
        return;
      }
      const loaded = await desktopApi.loadSession(state.cwd, session.id);
      if (!loaded) {
        return;
      }
      state.currentSessionId = loaded.id;
      renderSessions();
      renderSessionTranscript(loaded.events);
      resetProgress();
      setStatus("Conversation restored.");
    });

    card.append(header, openButton);
    elements.sessionList.append(card);
  }

  fitAllSessionCards();
}

async function deleteSessionFromUi(session) {
  if (state.running) {
    setStatus("Wait for the current run to finish before deleting sessions.");
    return;
  }

  if (!desktopApi) {
    setStatus("Desktop IPC bridge is unavailable.");
    return;
  }

  const title = session.lastUserPrompt || "Untitled session";
  const confirmed = window.confirm(`Delete this session?\n\n${title}\n\nThis cannot be undone.`);
  if (!confirmed) {
    return;
  }

  const payload = await desktopApi.deleteSession(state.cwd, session.id);
  state.sessions = payload?.sessions || [];

  if (!payload?.deleted) {
    renderSessions();
    setStatus("Could not delete that session.");
    return;
  }

  if (state.currentSessionId === session.id) {
    state.currentSessionId = null;
    resetTranscriptView();
    resetLogPanels();
    resetProgress();
  }

  renderSessions();
  setStatus(`Deleted session: ${truncateText(title, 80)}`);
}

function populateModelOptions(options, selectedModel) {
  const nextOptions = Array.isArray(options) ? options : [];
  elements.modelInput.textContent = "";

  const grouped = new Map();
  for (const option of nextOptions) {
    const family = option.family || "Other";
    const bucket = grouped.get(family) || [];
    bucket.push(option);
    grouped.set(family, bucket);
  }

  for (const [family, familyOptions] of grouped.entries()) {
    const group = document.createElement("optgroup");
    group.label = family;

    for (const option of familyOptions) {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.label;
      group.append(element);
    }

    elements.modelInput.append(group);
  }

  const fallbackModel = nextOptions[0]?.id || "kimi-k2.5";
  const selectedValue = nextOptions.some((option) => option.id === selectedModel) ? selectedModel : fallbackModel;
  elements.modelInput.value = selectedValue;
  state.model = selectedValue;
}

function applyConfigToUi(cwd, config, sessions, modelOptions) {
  state.cwd = cwd;
  state.modelOptions = Array.isArray(modelOptions) ? modelOptions : state.modelOptions;
  state.sessions = sessions || [];

  elements.workspaceInput.value = state.cwd;
  elements.maxTurnsInput.value = String(config.maxTurns || 12);
  elements.approveAllToggle.checked = Boolean(config.approveAll);
  elements.previewWritesToggle.checked = config.previewEdits !== false;
  populateModelOptions(state.modelOptions, config.model || state.model || "kimi-k2.5");
  setPreset(config.preset || state.preset || "default");

  renderSessions();
}

function resetTranscriptView() {
  elements.transcript.textContent = "";
  state.threadContexts = new Map();
  state.assistantStates = new Map();
  state.runThreadMap = new Map();
  state.pendingThreadId = null;
  state.currentRunId = null;
  state.nextThreadIndex = 1;
}

function renderSessionTranscript(events) {
  resetTranscriptView();
  resetLogPanels();

  let currentThreadId = null;
  let currentRunId = null;
  let threadIndex = 0;

  for (const event of events) {
    const shouldStartNewThread =
      event.type === "user" ||
      !currentThreadId ||
      (event.runId && event.runId !== currentRunId);

    if (shouldStartNewThread) {
      threadIndex += 1;
      const promptPreview = event.type === "user" ? event.text : `Recovered thread ${threadIndex}`;
      currentThreadId = `loaded-thread-${threadIndex}`;
      currentRunId = event.runId ?? currentThreadId;
      state.runThreadMap.set(currentRunId, currentThreadId);
      createThreadContext({
        threadId: currentThreadId,
        title: createThreadTitle(threadIndex, promptPreview),
        subtitle: formatTime(event.timestamp),
        status: "Loaded",
        statusTone: "",
      });
      state.nextThreadIndex = threadIndex + 1;
    }

    if (event.type === "user") {
      createBubble("user", event.text, currentThreadId);
      continue;
    }

    if (event.type === "assistant") {
      appendAssistantEvent(currentThreadId, event.text);
      continue;
    }

    if (event.type === "tool_call") {
      if (COMMAND_TOOL_NAMES.has(event.toolName)) {
        upsertCommandLogEntry({
          id: event.callId,
          title: event.toolName,
          meta: `Started ${formatTime(event.timestamp)}`,
          status: "pending",
          statusLabel: "Pending",
          summary: summarizeArguments(event.toolName, event.input || {}),
          detail: "",
          diff: "",
        });
      } else {
        upsertInlineActivityEntry(currentThreadId, {
          id: event.callId,
          title: event.toolName,
          meta: `Started ${formatTime(event.timestamp)}`,
          status: "pending",
          statusLabel: "Pending",
          summary: summarizePendingTool(event.toolName, event.input || {}),
          detail: "",
          diff: "",
        });
      }
      continue;
    }

    if (event.type === "tool_result") {
      const diff = typeof event.result?.metadata?.diff === "string" ? event.result.metadata.diff : "";
      const entry = {
        id: event.callId,
        title: event.toolName,
        meta: `Completed ${formatTime(event.timestamp)}`,
        status: isInformationalToolResult(event.result) ? "info" : event.result.ok ? "completed" : "failed",
        statusLabel: isInformationalToolResult(event.result) ? "Info" : event.result.ok ? "Completed" : "Failed",
        summary: COMMAND_TOOL_NAMES.has(event.toolName)
          ? event.result.ok ? "completed" : event.result.error.message
          : summarizeNonCommandTool(event.toolName, event.result, event.result.ok ? "" : event.result.error.message),
        detail: typeof event.result.content === "string" ? truncateText(event.result.content, 900) : "",
        diff,
      };
      if (COMMAND_TOOL_NAMES.has(event.toolName)) {
        upsertCommandLogEntry(entry);
      } else {
        upsertInlineActivityEntry(currentThreadId, entry);
      }
    }
  }
}

function formatTokenCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }

  return String(value);
}

function progressPhaseLabel(phase) {
  switch (phase) {
    case "starting":
      return "Starting";
    case "tool-call":
      return "Tool Call";
    case "running-tools":
      return "Running Tools";
    case "tool-result":
      return "Tool Result";
    case "tool-error":
      return "Tool Error";
    case "awaiting-approval":
      return "Awaiting Approval";
    case "responding":
      return "Responding";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function progressPhaseTone(phase) {
  switch (phase) {
    case "completed":
      return "is-success";
    case "cancelled":
    case "error":
    case "tool-error":
      return "is-error";
    case "awaiting-approval":
    case "tool-call":
    case "running-tools":
      return "is-warning";
    default:
      return "";
  }
}

function resetProgress(copy = {}) {
  state.progress = {
    ...createDefaultProgressState(),
    ...copy,
  };
  renderProgress();
}

function updateProgress(patch) {
  state.progress = {
    ...state.progress,
    ...patch,
    usage: {
      ...(state.progress.usage || {}),
      ...(patch.usage || {}),
    },
  };
  renderProgress();
}

function renderProgress() {
  const progress = state.progress;
  const turnsCompleted = Number(progress.completedTurns || 0);
  const maxTurns = Number(progress.maxTurns || 0);
  const fill =
    progress.phase === "completed"
      ? 100
      : maxTurns > 0
        ? Math.max(6, Math.min(100, Math.round((turnsCompleted / maxTurns) * 100)))
        : progress.phase === "idle"
          ? 0
          : 12;

  let title = progress.title || "Ready for a new run.";
  let subtitle = progress.subtitle || "Tool and token progress will appear here.";

  if (!progress.title) {
    if (progress.phase === "idle") {
      title = "Ready for a new run.";
      subtitle = "Tool and token progress will appear here.";
    } else if (progress.phase === "awaiting-approval") {
      title = `Approval needed${progress.activeToolName ? ` for ${progress.activeToolName}` : ""}`;
      subtitle = "The run is paused until you approve or deny the request.";
    } else if (progress.phase === "completed") {
      title = `Run ${progress.threadIndex ?? ""} complete`.trim();
      subtitle = progress.model ? `${progress.model} finished successfully.` : "The current run finished successfully.";
    } else if (progress.phase === "cancelled") {
      title = "Run cancelled.";
      subtitle = "The current run was stopped before completion.";
    } else if (progress.phase === "error") {
      title = "Run failed.";
      subtitle = progress.statusMessage || "The current run ended with an error.";
    } else if (progress.phase === "tool-call" || progress.phase === "running-tools" || progress.phase === "tool-result") {
      title = progress.activeToolName ? `Using ${progress.activeToolName}` : "Using tools";
      subtitle = progress.model ? `${progress.model} is inspecting or acting on the workspace.` : "The model is working through tool steps.";
    } else if (progress.phase === "responding") {
      title = "Drafting response";
      subtitle = progress.model ? `${progress.model} is writing the next reply.` : "The model is writing the next reply.";
    } else if (progress.phase === "starting") {
      title = "Starting run";
      subtitle = progress.model ? `Preparing ${progress.model} for this workspace.` : "Preparing the selected model.";
    }
  }

  elements.progressTitle.textContent = title;
  elements.progressSubtitle.textContent = subtitle;
  elements.progressBarFill.style.width = `${fill}%`;
  const showProgress =
    progress.phase !== "idle" &&
    progress.phase !== "completed" &&
    !(progress.phase === "cancelled" && !progress.statusMessage);
  elements.progressToggle.classList.toggle("hidden", !showProgress);
  elements.progressStrip.classList.toggle("is-hidden", !showProgress || state.runDetailsCollapsed);

  const chips = [
    {
      label: progressPhaseLabel(progress.phase),
      tone: progressPhaseTone(progress.phase),
    },
  ];

  if (progress.threadIndex) {
    chips.push({ label: `Thread ${progress.threadIndex}` });
  }

  if (progress.model) {
    chips.push({ label: progress.model });
  }

  if (maxTurns > 0) {
    chips.push({ label: `Turns ${turnsCompleted}/${maxTurns}` });
  }

  chips.push({ label: `Tools ${progress.toolCalls || 0}` });
  chips.push({ label: `Commands ${progress.commandCalls || 0}` });

  const inputTokens = formatTokenCount(progress.usage?.inputTokens);
  const outputTokens = formatTokenCount(progress.usage?.outputTokens);
  const totalTokens = formatTokenCount(progress.usage?.totalTokens);
  if (inputTokens) {
    chips.push({ label: `Input ${inputTokens}` });
  }
  if (outputTokens) {
    chips.push({ label: `Output ${outputTokens}` });
  }
  if (totalTokens) {
    chips.push({ label: `Total ${totalTokens}` });
  }

  elements.progressChips.textContent = "";
  for (const chip of chips) {
    const element = document.createElement("div");
    element.className = "progress-chip";
    if (chip.tone) {
      element.classList.add(chip.tone);
    }
    element.textContent = chip.label;
    elements.progressChips.append(element);
  }
}

async function refreshSessions() {
  if (!desktopApi) {
    throw new Error("Desktop IPC bridge is unavailable.");
  }
  state.sessions = await desktopApi.listSessions(state.cwd);
  renderSessions();
}

async function bootstrap() {
  try {
    appendDebug("bootstrap:start");
    if (!desktopApi) {
      throw new Error("Desktop IPC bridge is unavailable.");
    }
    const payload = await desktopApi.getBootstrap();
    applyConfigToUi(payload.cwd, payload.config, payload.sessions, payload.modelOptions);
    renderApprovals();
    resetLogPanels();
    resetProgress();
    setStatus(payload.hasApiKey ? "Ready for the next message." : "MODEL_ACCESS_KEY is not set.");
    appendDebug(`bootstrap:ready cwd=${payload.cwd} hasApiKey=${String(payload.hasApiKey)}`);
  } catch (error) {
    setStatus(toErrorMessage(error));
    appendDebug(`bootstrap:error ${toErrorMessage(error)}`);
  }
}

async function reloadWorkspaceState() {
  const cwd = elements.workspaceInput.value.trim() || state.cwd;
  try {
    if (!desktopApi) {
      throw new Error("Desktop IPC bridge is unavailable.");
    }
    const payload = await desktopApi.getBootstrap(cwd);
    applyConfigToUi(payload.cwd, payload.config, payload.sessions, payload.modelOptions);
    resetTranscriptView();
    resetLogPanels();
    resetProgress();
    setStatus(payload.hasApiKey ? "Workspace ready." : "MODEL_ACCESS_KEY is not set.");
  } catch (error) {
    setStatus(toErrorMessage(error));
  }
}

async function chooseWorkspace() {
  if (!desktopApi) {
    throw new Error("Desktop IPC bridge is unavailable.");
  }

  const selected = await desktopApi.chooseWorkspace(elements.workspaceInput.value.trim() || state.cwd);
  if (!selected) {
    return;
  }

  elements.workspaceInput.value = selected;
  await reloadWorkspaceState();
  setStatus(`Selected workspace ${selected}`);
}

async function saveConfig() {
  const config = {
    model: elements.modelInput.value,
    approveAll: elements.approveAllToggle.checked,
    previewEdits: elements.previewWritesToggle.checked,
    maxTurns: Number.parseInt(elements.maxTurnsInput.value || "12", 10),
    preset: state.preset,
  };
  const cwd = elements.workspaceInput.value.trim();
  if (!desktopApi) {
    throw new Error("Desktop IPC bridge is unavailable.");
  }
  await desktopApi.saveConfig(cwd, config);
  await reloadWorkspaceState();
  setStatus(`Saved workspace defaults for ${cwd}.`);
}

function createLiveThread(prompt, { resumeLast = false } = {}) {
  const threadId = startNewThread(prompt, {
    threadIndex: state.nextThreadIndex,
    subtitle: resumeLast ? "Continuing the most recent session..." : "Preparing run...",
    status: "Queued",
  });
  createBubble("user", prompt, threadId);
  return threadId;
}

async function startRun({ resumeLast = false } = {}) {
  if (state.running) {
    return;
  }

  const prompt = elements.promptInput.value.trim();
  if (!prompt) {
    setStatus("Enter a prompt to start.");
    return;
  }

  const promptBackup = elements.promptInput.value;
  state.cwd = elements.workspaceInput.value.trim() || state.cwd;
  state.model = elements.modelInput.value || state.model || "kimi-k2.5";
  appendDebug(`startRun:clicked cwd=${state.cwd} model=${state.model} resumeLast=${String(resumeLast)} prompt="${prompt}"`);
  state.cancelRequested = false;

  const threadId = createLiveThread(prompt, { resumeLast });
  state.pendingThreadId = threadId;
  elements.promptInput.value = "";
  setRunning(true);
  updateProgress({
    runId: null,
    threadIndex: state.nextThreadIndex - 1,
    model: state.model,
    maxTurns: Number.parseInt(elements.maxTurnsInput.value || "12", 10),
    completedTurns: 0,
    toolCalls: 0,
    commandCalls: 0,
    usage: {},
    phase: "starting",
  });
  setStatus(`Submitting request for ${state.model}...`);
  state.waitingTimer = setTimeout(() => {
    appendDebug("ui:still waiting for provider response");
    setStatus(`Still waiting for ${state.model}...`);
  }, 5000);

  try {
    if (!desktopApi) {
      throw new Error("Desktop IPC bridge is unavailable.");
    }
    await desktopApi.startRun({
      cwd: state.cwd,
      prompt,
      model: state.model,
      preset: state.preset,
      approveAll: elements.approveAllToggle.checked,
      previewWrites: elements.previewWritesToggle.checked,
      maxTurns: Number.parseInt(elements.maxTurnsInput.value || "12", 10),
      sessionId: resumeLast ? null : state.currentSessionId,
      resumeLast,
    });
    appendDebug("startRun:invoke resolved");
  } catch (error) {
    elements.promptInput.value = promptBackup;
    const message = toErrorMessage(error);
    if (!state.cancelRequested) {
      createBubble("system", message, threadId);
      updateThreadContext(threadId, {
        status: "Failed",
        statusTone: "is-error",
        subtitle: message,
      });
      updateProgress({
        phase: "error",
        statusMessage: message,
      });
    }
    setStatus(message);
    appendDebug(`startRun:error ${message}`);
    setRunning(false);
  }
}

if (desktopApi) {
  desktopApi.onEvent(async (payload) => {
    appendDebug(`event:${payload.type}`);

    if (payload.type === "assistant-delta") {
      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (!threadId) {
        return;
      }

      const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
      const assistantState = getAssistantState(threadId);
      if (!assistantState.bubble && !chunk.trim()) {
        return;
      }
      if (!assistantState.bubble) {
        assistantState.bubble = createBubble("assistant", "", threadId);
      }
      assistantState.turnText += chunk;
      const mergedText = mergeAssistantText(assistantState.renderedText, assistantState.turnText);
      setBubbleContent(assistantState.bubble, "assistant", mergedText);
      assistantState.visibleText = mergedText;
      elements.transcript.scrollTop = elements.transcript.scrollHeight;
      return;
    }

    if (payload.type === "assistant-complete") {
      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (!threadId) {
        return;
      }

      const assistantState = getAssistantState(threadId);
      const mergedText = chooseMoreCompleteAssistantText(
        assistantState.visibleText,
        mergeAssistantText(assistantState.renderedText, assistantState.turnText),
      );
      if (assistantState.bubble && !mergedText.trim()) {
        assistantState.bubble.wrapper.remove();
        assistantState.bubble = null;
        assistantState.visibleText = "";
      } else if (mergedText.trim()) {
        commitAssistantText(assistantState, mergedText);
      }
      assistantState.turnText = "";
      return;
    }

    if (payload.type === "tool-call") {
      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (COMMAND_TOOL_NAMES.has(payload.toolCall.name)) {
        upsertCommandLogEntry(createPendingToolEntry(payload));
      } else if (threadId) {
        upsertInlineActivityEntry(threadId, createPendingToolEntry(payload));
      }
      updateProgress({
        phase: "tool-call",
        activeToolName: payload.toolCall.name,
      });
      return;
    }

    if (payload.type === "tool-result") {
      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (COMMAND_TOOL_NAMES.has(payload.toolCall.name)) {
        upsertCommandLogEntry(createFinishedToolEntry(payload));
      } else if (threadId) {
        upsertInlineActivityEntry(threadId, createFinishedToolEntry(payload));
      }
      updateProgress({
        phase: payload.result?.ok ? "tool-result" : "tool-error",
        activeToolName: payload.toolCall.name,
      });
      return;
    }

    if (payload.type === "approval-request") {
      state.approvals.unshift(payload);
      renderApprovals();
      updateProgress({
        phase: "awaiting-approval",
        activeToolName: payload.toolName,
      });
      setStatus(`Approval needed for ${payload.toolName}.`);
      return;
    }

    if (payload.type === "run-started") {
      const threadId = state.pendingThreadId ?? startNewThread(payload.prompt || "", {
        threadIndex: payload.threadIndex,
        subtitle: "Run started",
        status: "Running",
        statusTone: "is-warning",
      });
      state.runThreadMap.set(payload.runId, threadId);
      state.currentRunId = payload.runId;
      updateThreadContext(threadId, {
        title: createThreadTitle(payload.threadIndex || state.nextThreadIndex, payload.prompt || ""),
        subtitle: `${payload.model} • ${formatWorkspaceLabel(payload.cwd)}`,
        status: "Running",
        statusTone: "is-warning",
      });
      updateProgress({
        runId: payload.runId,
        threadIndex: payload.threadIndex,
        model: payload.model,
        maxTurns: payload.maxTurns || state.progress.maxTurns,
        phase: "starting",
      });
      setStatus(`Working with ${payload.model} in ${formatWorkspaceLabel(payload.cwd)}.`);
      return;
    }

    if (payload.type === "run-progress") {
      updateProgress({
        runId: payload.runId ?? state.progress.runId,
        threadIndex: payload.threadIndex || state.progress.threadIndex,
        maxTurns: payload.maxTurns || state.progress.maxTurns,
        completedTurns: payload.completedTurns ?? state.progress.completedTurns,
        toolCalls: payload.toolCalls ?? state.progress.toolCalls,
        commandCalls: payload.commandCalls ?? state.progress.commandCalls,
        phase: payload.phase || state.progress.phase,
        activeToolName: payload.activeToolName ?? state.progress.activeToolName,
        usage: payload.usage || {},
      });
      return;
    }

    if (payload.type === "run-complete") {
      setRunning(false);
      state.cancelRequested = false;
      state.currentSessionId = payload.sessionId;
      state.sessions = payload.sessions || state.sessions;
      renderSessions();

      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (threadId) {
        const assistantState = getAssistantState(threadId);
        const authoritativeText = getAuthoritativeAssistantText(payload);
        if (authoritativeText.trim()) {
          const nextText = chooseMoreCompleteAssistantText(assistantState.visibleText, authoritativeText);
          if (assistantState.bubble) {
            commitAssistantText(assistantState, nextText);
          } else {
            assistantState.bubble = createBubble("assistant", nextText, threadId);
            assistantState.renderedText = nextText;
            assistantState.visibleText = nextText;
          }
        }
        assistantState.turnText = "";

        updateThreadContext(threadId, {
          subtitle: formatTime(new Date().toISOString()),
          status: "Completed",
          statusTone: "is-success",
        });
      }

      updateProgress({
        phase: "completed",
        usage: payload.usage || {},
      });
      setStatus("Ready for the next message.");
      state.pendingThreadId = null;
      return;
    }

    if (payload.type === "run-cancelled") {
      setRunning(false);
      state.cancelRequested = false;
      state.approvals = [];
      renderApprovals();
      const threadId = state.currentRunId ? state.runThreadMap.get(state.currentRunId) : state.pendingThreadId;
      if (threadId) {
        updateThreadContext(threadId, {
          subtitle: payload.message || "Run cancelled.",
          status: "Cancelled",
          statusTone: "is-error",
        });
      }
      updateProgress({
        phase: "cancelled",
        statusMessage: payload.message || "Run cancelled.",
      });
      setStatus(payload.message || "Run cancelled.");
      state.pendingThreadId = null;
      return;
    }

    if (payload.type === "run-error") {
      setRunning(false);
      const threadId = payload.runId ? state.runThreadMap.get(payload.runId) : state.pendingThreadId;
      if (!state.cancelRequested && threadId) {
        createBubble("system", payload.message, threadId);
        updateThreadContext(threadId, {
          subtitle: payload.message,
          status: "Failed",
          statusTone: "is-error",
        });
      }
      updateProgress({
        phase: "error",
        statusMessage: payload.message,
      });
      setStatus(payload.message);
      state.pendingThreadId = null;
      return;
    }

    if (payload.type === "debug-log") {
      appendDebug(payload.message);
    }
  });
}

elements.sendButton.addEventListener("click", async () => {
  await startRun();
});

elements.resumeButton.addEventListener("click", async () => {
  await startRun({ resumeLast: true });
});

elements.cancelButton.addEventListener("click", async () => {
  if (!state.running || !desktopApi) {
    return;
  }

  state.cancelRequested = true;
  appendDebug("cancelRun:clicked");
  updateProgress({
    phase: "cancelled",
    statusMessage: "Cancelling current run...",
  });
  setStatus("Cancelling current run...");
  await desktopApi.cancelRun();
});

elements.detailPaneToggle.addEventListener("click", () => {
  toggleRightPane();
});

elements.progressToggle.addEventListener("click", () => {
  toggleRunDetails();
});

elements.refreshSessionsButton.addEventListener("click", async () => {
  await reloadWorkspaceState();
  setStatus("Workspace state refreshed.");
});

elements.saveConfigButton.addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (error) {
    setStatus(toErrorMessage(error));
  }
});

elements.workspaceInput.addEventListener("change", async () => {
  await reloadWorkspaceState();
});

elements.workspaceInput.addEventListener("click", async () => {
  try {
    await chooseWorkspace();
  } catch (error) {
    setStatus(toErrorMessage(error));
  }
});

elements.workspaceInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  try {
    await chooseWorkspace();
  } catch (error) {
    setStatus(toErrorMessage(error));
  }
});

elements.promptInput.addEventListener("keydown", async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    await startRun();
  }
});

bootstrap();
setRunning(false);
resetLogPanels();
resetProgress();
renderPresetButtons();
setPreset(state.preset);
loadPaneWidthPreference();
loadPaneCollapsedPreference();
loadRunDetailsPreference();
initializeResizeHandle();
window.addEventListener("resize", () => {
  applyRightPaneWidth(state.rightPaneWidth);
  fitAllSessionCards();
});
