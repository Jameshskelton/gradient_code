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

const RUN_DETAILS_COLLAPSED_KEY = "gradient-code:run-details-collapsed";
const ACTIVITY_FILTERS = [
  { id: "conversation", label: "Conversation", activeByDefault: true },
  { id: "tools", label: "Tools", activeByDefault: true },
  { id: "commands", label: "Commands", activeByDefault: true },
  { id: "debug", label: "Debug", activeByDefault: false },
];

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
  runDetailsCollapsed: true,
  cancelRequested: false,
  progress: createDefaultProgressState(),
  threadContexts: new Map(),
  assistantStates: new Map(),
  runThreadMap: new Map(),
  activityEntryMap: new Map(),
  workspaceThreadId: null,
  activeFilters: new Set(
    ACTIVITY_FILTERS.filter((filter) => filter.activeByDefault).map((filter) => filter.id),
  ),
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
  activityFilters: document.getElementById("activityFilters"),
  transcript: document.getElementById("transcript"),
  composerForm: document.getElementById("composerForm"),
  promptInput: document.getElementById("promptInput"),
  sendButton: document.getElementById("sendButton"),
  resumeButton: document.getElementById("resumeButton"),
  cancelButton: document.getElementById("cancelButton"),
  sessionList: document.getElementById("sessionList"),
  refreshSessionsButton: document.getElementById("refreshSessionsButton"),
};
let presetButtons = [];

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

function isFilterActive(category) {
  return state.activeFilters.has(category);
}

function updateFilterButtonState(button, category) {
  const active = isFilterActive(category);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
}

function applyActivityFilters() {
  elements.transcript.querySelectorAll(".timeline-entry").forEach((entry) => {
    const category = entry.dataset.category || "conversation";
    entry.classList.toggle("is-filtered-out", !isFilterActive(category));
  });

  elements.transcript.querySelectorAll(".thread-section").forEach((section) => {
    const hasVisibleEntries = [...section.querySelectorAll(".timeline-entry")].some(
      (entry) => !entry.classList.contains("is-filtered-out"),
    );
    section.classList.toggle("is-filtered-out", !hasVisibleEntries);
  });
}

function renderActivityFilters() {
  elements.activityFilters.textContent = "";
  for (const filter of ACTIVITY_FILTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "activity-filter-chip";
    button.dataset.category = filter.id;
    button.textContent = filter.label;
    updateFilterButtonState(button, filter.id);
    button.addEventListener("click", () => {
      if (state.activeFilters.has(filter.id)) {
        state.activeFilters.delete(filter.id);
      } else {
        state.activeFilters.add(filter.id);
      }
      updateFilterButtonState(button, filter.id);
      applyActivityFilters();
    });
    elements.activityFilters.append(button);
  }
}

function findBestDebugThreadId() {
  if (state.currentRunId && state.runThreadMap.has(state.currentRunId)) {
    return state.runThreadMap.get(state.currentRunId);
  }

  if (state.pendingThreadId) {
    return state.pendingThreadId;
  }

  return state.workspaceThreadId ?? ensureWorkspaceThread();
}

function appendDebug(message) {
  const threadId = findBestDebugThreadId();
  if (!threadId) {
    return;
  }

  const detail = String(message || "");
  const summary = truncateText(detail, 220);

  appendTimelineEntry(threadId, {
    id: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: "debug",
    label: "Debug",
    title: truncateText(detail, 120) || "Debug event",
    meta: formatTime(new Date().toISOString()),
    status: "info",
    statusLabel: "Debug",
    summary,
    detail: detail.length > summary.length ? detail : "",
    compact: true,
  });
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

function decorateTimelineEntry(element, category) {
  element.classList.add("timeline-entry");
  element.dataset.category = category;
  element.classList.toggle("is-filtered-out", !isFilterActive(category));
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

function ensureWorkspaceThread() {
  if (state.workspaceThreadId && state.threadContexts.has(state.workspaceThreadId)) {
    return state.workspaceThreadId;
  }

  const threadId = "workspace-thread";
  state.workspaceThreadId = threadId;
  createThreadContext({
    threadId,
    title: "Workspace activity",
    subtitle: state.cwd ? formatWorkspaceLabel(state.cwd) : "Desktop shell",
    status: "Ready",
    statusTone: "",
  });
  return threadId;
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

function createBubble(role, text, threadId) {
  const context = ensureThreadContext(threadId, {
    title: `Conversation ${state.nextThreadIndex}`,
    subtitle: "Session thread",
    status: "Loaded",
  });

  const wrapper = document.createElement("div");
  wrapper.className = `bubble ${role}`;
  decorateTimelineEntry(wrapper, "conversation");
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

function buildDisclosure(label, className, text, open = false) {
  const disclosure = document.createElement("details");
  disclosure.className = "timeline-entry-disclosure";
  disclosure.open = open;

  const summary = document.createElement("summary");
  summary.className = "timeline-entry-disclosure-toggle";
  summary.textContent = label;

  const body = document.createElement("pre");
  body.className = className;
  body.textContent = text;

  disclosure.append(summary, body);
  return disclosure;
}

function createTimelineEntryElement(entry) {
  const card = document.createElement("article");
  card.className = "panel-entry";
  decorateTimelineEntry(card, entry.category);

  if (entry.compact) {
    card.classList.add("timeline-entry-compact");
  }
  if (entry.approval) {
    card.classList.add("timeline-entry-approval", "timeline-entry-elevated");
  }
  if (entry.diff) {
    card.classList.add("timeline-entry-edit", "timeline-entry-elevated");
  }
  if (entry.status === "failed" || entry.status === "error") {
    card.classList.add("timeline-entry-error", "timeline-entry-elevated");
  }

  if (entry.label) {
    const label = document.createElement("div");
    label.className = "panel-entry-label";
    label.textContent = entry.label;
    card.append(label);
  }

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
  header.append(titleWrap);

  if (entry.statusLabel) {
    const status = document.createElement("div");
    status.className = "panel-entry-status";
    const tone = pickEntryTone(entry.status);
    if (tone) {
      status.classList.add(tone);
    }
    status.textContent = entry.statusLabel;
    header.append(status);
  }

  card.append(header);

  if (entry.summary) {
    const summary = document.createElement("div");
    summary.className = "panel-entry-summary";
    if (entry.markdown === true) {
      summary.innerHTML = renderMarkdown(entry.summary);
    } else {
      summary.textContent = entry.summary;
    }
    card.append(summary);
  }

  if (entry.detail) {
    card.append(buildDisclosure("Raw output", "panel-entry-detail", entry.detail, entry.status === "failed"));
  }

  if (entry.diff) {
    card.append(buildDisclosure("Diff preview", "panel-entry-diff", entry.diff));
  }

  if (entry.requestText) {
    card.append(buildDisclosure("Request details", "panel-entry-detail", entry.requestText, true));
  }

  if (typeof entry.renderActions === "function") {
    card.append(entry.renderActions());
  }

  return card;
}

function activityEntryKey(threadId, entryId) {
  return `${threadId}:${entryId}`;
}

function appendTimelineEntry(threadId, entry) {
  const context = ensureThreadContext(threadId, {
    title: `Conversation ${state.nextThreadIndex}`,
    subtitle: "Session thread",
    status: "Loaded",
  });
  const element = createTimelineEntryElement(entry);
  context.body.append(element);
  state.activityEntryMap.set(activityEntryKey(threadId, entry.id), { entry, element });
  applyActivityFilters();
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return element;
}

function upsertTimelineEntry(threadId, nextEntry) {
  const key = activityEntryKey(threadId, nextEntry.id);
  const existing = state.activityEntryMap.get(key);
  if (!existing) {
    return appendTimelineEntry(threadId, nextEntry);
  }

  const merged = {
    ...existing.entry,
    ...nextEntry,
  };
  const nextElement = createTimelineEntryElement(merged);
  existing.element.replaceWith(nextElement);
  state.activityEntryMap.set(key, { entry: merged, element: nextElement });
  applyActivityFilters();
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return nextElement;
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

function createPendingToolEntry(payload) {
  const toolCall = payload.toolCall;
  return {
    id: toolCall.callId,
    category: COMMAND_TOOL_NAMES.has(toolCall.name) ? "commands" : "tools",
    label: COMMAND_TOOL_NAMES.has(toolCall.name) ? "Command" : "Tool",
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
    category: COMMAND_TOOL_NAMES.has(toolCall.name) ? "commands" : "tools",
    label: COMMAND_TOOL_NAMES.has(toolCall.name) ? "Command" : "Tool",
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

async function respondToApproval(approval, approved) {
  appendDebug(`approval:click ${approved ? "approve" : "deny"} requestId=${approval.requestId}`);
  if (!desktopApi) {
    setStatus("Desktop IPC bridge is unavailable.");
    appendDebug("approval:error desktopApi missing");
    return;
  }

  await desktopApi.respondApproval(approval.requestId, approved);
  state.approvals = state.approvals.filter((item) => item.requestId !== approval.requestId);
  upsertTimelineEntry(approval.threadId, createApprovalTimelineEntry(approval, approved ? "approved" : "denied"));
  updateProgress({
    phase: approved ? "running-tools" : "tool-error",
    activeToolName: approval.toolName,
  });
  setStatus(`${approved ? "Approved" : "Denied"} ${approval.toolName}. Waiting for run to continue...`);
}

function createApprovalTimelineEntry(approval, resolution = "pending") {
  const { requestText, diffText } = splitApprovalSummary(approval.summary);
  const status = resolution === "approved" ? "completed" : resolution === "denied" ? "failed" : "pending";
  const statusLabel = resolution === "approved" ? "Approved" : resolution === "denied" ? "Denied" : "Needs Review";

  return {
    id: approval.requestId,
    category: "tools",
    label: "Approval",
    title: approval.toolName,
    meta: resolution === "pending" ? "Action paused until you decide" : `Decision recorded ${formatTime(new Date().toISOString())}`,
    status,
    statusLabel,
    summary: resolution === "pending"
      ? `Review the ${approval.toolName} request before the run continues.`
      : resolution === "approved"
        ? `${approval.toolName} was approved and the run can continue.`
        : `${approval.toolName} was denied.`,
    requestText,
    diff: diffText,
    approval: true,
    renderActions: resolution !== "pending"
      ? null
      : () => {
          const actions = document.createElement("div");
          actions.className = "timeline-entry-actions";

          const approveButton = document.createElement("button");
          approveButton.className = "solid-button";
          approveButton.textContent = "Approve";
          approveButton.addEventListener("click", async () => {
            await respondToApproval(approval, true);
          });

          const denyButton = document.createElement("button");
          denyButton.className = "ghost-button";
          denyButton.textContent = "Deny";
          denyButton.addEventListener("click", async () => {
            await respondToApproval(approval, false);
          });

          actions.append(approveButton, denyButton);
          return actions;
        },
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
  state.activityEntryMap = new Map();
  state.workspaceThreadId = null;
  state.pendingThreadId = null;
  state.currentRunId = null;
  state.nextThreadIndex = 1;
}

function renderSessionTranscript(events) {
  resetTranscriptView();

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
      upsertTimelineEntry(currentThreadId, {
        id: event.callId,
        category: COMMAND_TOOL_NAMES.has(event.toolName) ? "commands" : "tools",
        label: COMMAND_TOOL_NAMES.has(event.toolName) ? "Command" : "Tool",
        title: event.toolName,
        meta: `Started ${formatTime(event.timestamp)}`,
        status: "pending",
        statusLabel: "Pending",
        summary: summarizePendingTool(event.toolName, event.input || {}),
        detail: "",
        diff: "",
      });
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
        category: COMMAND_TOOL_NAMES.has(event.toolName) ? "commands" : "tools",
        label: COMMAND_TOOL_NAMES.has(event.toolName) ? "Command" : "Tool",
      };
      upsertTimelineEntry(currentThreadId, entry);
    }
  }

  applyActivityFilters();
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
    if (state.workspaceThreadId) {
      updateThreadContext(state.workspaceThreadId, {
        subtitle: formatWorkspaceLabel(payload.cwd),
      });
    }
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
    ensureWorkspaceThread();
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
      if (threadId) {
        upsertTimelineEntry(threadId, createPendingToolEntry(payload));
      }
      updateProgress({
        phase: "tool-call",
        activeToolName: payload.toolCall.name,
      });
      return;
    }

    if (payload.type === "tool-result") {
      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (threadId) {
        upsertTimelineEntry(threadId, createFinishedToolEntry(payload));
      }
      updateProgress({
        phase: payload.result?.ok ? "tool-result" : "tool-error",
        activeToolName: payload.toolCall.name,
      });
      return;
    }

    if (payload.type === "approval-request") {
      const threadId =
        (payload.runId ? state.runThreadMap.get(payload.runId) : null) ??
        (state.currentRunId ? state.runThreadMap.get(state.currentRunId) : null) ??
        state.pendingThreadId ??
        ensureWorkspaceThread();
      const approval = {
        ...payload,
        threadId,
      };
      state.approvals.unshift(approval);
      upsertTimelineEntry(threadId, createApprovalTimelineEntry(approval));
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
      for (const approval of state.approvals) {
        upsertTimelineEntry(approval.threadId, {
          ...createApprovalTimelineEntry(approval),
          status: "info",
          statusLabel: "Cancelled",
          summary: `${approval.toolName} did not run because the session was cancelled.`,
          renderActions: null,
        });
      }
      state.approvals = [];
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

setRunning(false);
resetTranscriptView();
ensureWorkspaceThread();
resetProgress();
renderPresetButtons();
renderActivityFilters();
setPreset(state.preset);
loadRunDetailsPreference();
appendDebug(`desktopApi:${desktopApi ? "available" : "missing"}`);
bootstrap();
window.addEventListener("resize", () => {
  fitAllSessionCards();
});
