const COMMAND_TOOL_NAMES = new Set([
  "run_command",
  "start_command_session",
  "read_process_output",
  "send_process_input",
  "close_command_session",
]);
const NETWORK_APPROVAL_TOOL_NAMES = new Set(["web_search", "fetch_url"]);
const HIGH_RISK_COMMAND_PATTERN =
  /\b(rm|sudo|chmod|chown|dd|mkfs|launchctl|killall|pkill)\b|git\s+(reset|clean)\b|npm\s+publish\b|pnpm\s+publish\b|yarn\s+publish\b|cargo\s+publish\b|curl\b.*\|\s*(sh|bash|zsh)\b|wget\b.*\|\s*(sh|bash|zsh)\b|[>|]{2}|[|]\s*(sh|bash|zsh)\b/i;
const MEDIUM_RISK_COMMAND_PATTERN =
  /\b(npm|pnpm|yarn|bun|cargo|go|pytest|vitest|jest|playwright|cypress|make|docker|kubectl|terraform|gradle|mvn|swift|xcodebuild)\b/i;
const SENSITIVE_WRITE_PATH_PATTERN =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Dockerfile|docker-compose\.(yml|yaml)|\.env($|\.)|\.github\/|tsconfig(\.[^.]+)?\.json$|vite\.config|webpack\.config|rollup\.config|eslint\.config|prettier\.config|turbo\.json$|vercel\.json$|pnpm-workspace\.yaml$)/i;

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
const TOPBAR_COLLAPSED_KEY = "gradient-code:topbar-collapsed";
const INSPECTOR_COLLAPSED_KEY = "gradient-code:inspector-collapsed";
const INSPECTOR_SPLIT_KEY = "gradient-code:inspector-split";
const INSPECTOR_TABS = [
  { id: "browser", label: "Browser" },
  { id: "working-set", label: "Working Set" },
  { id: "notes", label: "Notes" },
];
const ACTIVITY_FILTERS = [
  { id: "conversation", label: "Conversation", activeByDefault: true },
  { id: "tools", label: "Tools", activeByDefault: true },
  { id: "commands", label: "Commands", activeByDefault: true },
  { id: "debug", label: "Debug", activeByDefault: false },
];
const DEFAULT_INSPECTOR_SPLIT = 0.52;
const INSPECTOR_MIN_PANEL_HEIGHT = 190;
const TIMELINE_BATCH_MIN_SIZE = 3;
const TIMELINE_BATCH_FAMILIES = new Map([
  ["read_file", "file-read"],
  ["read_many_files", "file-read"],
  ["inspect_path", "file-read"],
  ["find_symbol", "symbol-inspection"],
  ["find_references", "symbol-inspection"],
  ["list_exports", "symbol-inspection"],
  ["list_imports", "symbol-inspection"],
  ["search_text", "text-search"],
  ["list_files", "workspace-scan"],
  ["list_tree", "workspace-scan"],
]);
const COMMAND_PALETTE_FILE_LIMIT = 5000;

const state = {
  cwd: "",
  model: "",
  preset: "default",
  modelOptions: [],
  currentSessionId: null,
  branchSessionId: null,
  running: false,
  approvals: [],
  sessions: [],
  waitingTimer: null,
  runDetailsCollapsed: true,
  topbarCollapsed: false,
  topbarCollapsedPreference: false,
  topbarQuickEditor: null,
  inspectorCollapsed: true,
  inspectorCollapsedPreference: true,
  inspectorSplitRatio: DEFAULT_INSPECTOR_SPLIT,
  inspectorTab: "browser",
  workspaceTreeEntries: new Map(),
  workspaceTreeLoading: new Set(),
  expandedWorkspacePaths: new Set([""]),
  selectedBrowserPath: null,
  browserPreview: null,
  browserPreviewLoading: false,
  projectNotesPath: "",
  projectNotesContent: "",
  projectNotesSavedContent: "",
  projectNotesExists: false,
  projectNotesIncludeInPrompt: true,
  projectNotesSavedIncludeInPrompt: true,
  projectNotesIsCustomPath: false,
  projectNotesSaving: false,
  activeInspectorThreadId: null,
  threadTouchedFiles: new Map(),
  activeDiff: null,
  activeDiffFilePath: null,
  diffViewMode: "unified",
  cancelRequested: false,
  progress: createDefaultProgressState(),
  threadContexts: new Map(),
  assistantStates: new Map(),
  runThreadMap: new Map(),
  activityEntryMap: new Map(),
  timelineBatchOpen: new Set(),
  commandPaletteOpen: false,
  commandPaletteQuery: "",
  commandPaletteSelectedIndex: 0,
  commandPaletteWorkspacePath: "",
  commandPaletteFiles: [],
  commandPaletteLoading: false,
  commandPaletteToken: 0,
  commandPaletteResults: [],
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
      listWorkspaceTree: (cwd, relativePath) => ipcRenderer.invoke("desktop:list-workspace-tree", cwd, relativePath),
      readWorkspaceFile: (cwd, relativePath) => ipcRenderer.invoke("desktop:read-workspace-file", cwd, relativePath),
      openWorkspacePath: (cwd, relativePath) => ipcRenderer.invoke("desktop:open-workspace-path", cwd, relativePath),
      openHistoryFolder: (cwd) => ipcRenderer.invoke("desktop:open-history-folder", cwd),
      clearWorkspaceHistory: (cwd) => ipcRenderer.invoke("desktop:clear-workspace-history", cwd),
      saveProjectNotes: (cwd, payload) => ipcRenderer.invoke("desktop:save-project-notes", cwd, payload),
      openProjectNotes: (cwd) => ipcRenderer.invoke("desktop:open-project-notes", cwd),
      listSessions: (cwd) => ipcRenderer.invoke("desktop:list-sessions", cwd),
      loadSession: (cwd, sessionId) => ipcRenderer.invoke("desktop:load-session", cwd, sessionId),
      deleteSession: (cwd, sessionId) => ipcRenderer.invoke("desktop:delete-session", cwd, sessionId),
      saveConfig: (cwd, config) => ipcRenderer.invoke("desktop:save-config", cwd, config),
      startRun: (payload) => ipcRenderer.invoke("desktop:start-run", payload),
      cancelRun: () => ipcRenderer.invoke("desktop:cancel-run"),
      respondApproval: (requestId, response) => ipcRenderer.invoke("desktop:respond-approval", requestId, response),
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
  topbar: document.getElementById("topbar"),
  workspaceInput: document.getElementById("workspaceInput"),
  modelInput: document.getElementById("modelInput"),
  maxTurnsInput: document.getElementById("maxTurnsInput"),
  approveAllToggle: document.getElementById("approveAllToggle"),
  previewWritesToggle: document.getElementById("previewWritesToggle"),
  storeHistoryToggle: document.getElementById("storeHistoryToggle"),
  saveConfigButton: document.getElementById("saveConfigButton"),
  topbarSummary: document.getElementById("topbarSummary"),
  topbarCollapseButton: document.getElementById("topbarCollapseButton"),
  topbarExpandButton: document.getElementById("topbarExpandButton"),
  topbarQuickEditor: document.getElementById("topbarQuickEditor"),
  topbarQuickModelField: document.getElementById("topbarQuickModelField"),
  topbarQuickTurnsField: document.getElementById("topbarQuickTurnsField"),
  collapsedModelInput: document.getElementById("collapsedModelInput"),
  collapsedTurnsInput: document.getElementById("collapsedTurnsInput"),
  topbarQuickCloseButton: document.getElementById("topbarQuickCloseButton"),
  inspectorContext: document.getElementById("inspectorContext"),
  inspectorTabs: document.getElementById("inspectorTabs"),
  inspectorPane: document.querySelector(".inspector-pane"),
  inspectorResizeHandle: document.getElementById("inspectorResizeHandle"),
  browserToolbar: document.getElementById("browserToolbar"),
  projectNotesToolbar: document.getElementById("projectNotesToolbar"),
  reloadWorkspaceTreeButton: document.getElementById("reloadWorkspaceTreeButton"),
  openSelectedFileButton: document.getElementById("openSelectedFileButton"),
  browserView: document.getElementById("browserView"),
  workingSetView: document.getElementById("workingSetView"),
  projectNotesView: document.getElementById("projectNotesView"),
  workspaceTree: document.getElementById("workspaceTree"),
  filePreview: document.getElementById("filePreview"),
  workingSetSummary: document.getElementById("workingSetSummary"),
  workingSetList: document.getElementById("workingSetList"),
  projectNotesPath: document.getElementById("projectNotesPath"),
  projectNotesState: document.getElementById("projectNotesState"),
  projectNotesHint: document.getElementById("projectNotesHint"),
  projectNotesIncludeToggle: document.getElementById("projectNotesIncludeToggle"),
  projectNotesInput: document.getElementById("projectNotesInput"),
  saveProjectNotesButton: document.getElementById("saveProjectNotesButton"),
  openProjectNotesButton: document.getElementById("openProjectNotesButton"),
  diffInspectorMeta: document.getElementById("diffInspectorMeta"),
  diffUnifiedButton: document.getElementById("diffUnifiedButton"),
  diffSplitButton: document.getElementById("diffSplitButton"),
  diffInspectorEmpty: document.getElementById("diffInspectorEmpty"),
  diffInspectorSurface: document.getElementById("diffInspectorSurface"),
  diffFileTabs: document.getElementById("diffFileTabs"),
  diffPreviewFileButton: document.getElementById("diffPreviewFileButton"),
  diffOpenFileButton: document.getElementById("diffOpenFileButton"),
  diffInspectorContent: document.getElementById("diffInspectorContent"),
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
  inspectorToggleButton: document.getElementById("inspectorToggleButton"),
  transcript: document.getElementById("transcript"),
  commandPalette: document.getElementById("commandPalette"),
  commandPaletteBackdrop: document.getElementById("commandPaletteBackdrop"),
  commandPaletteInput: document.getElementById("commandPaletteInput"),
  commandPaletteMeta: document.getElementById("commandPaletteMeta"),
  commandPaletteResults: document.getElementById("commandPaletteResults"),
  composerForm: document.getElementById("composerForm"),
  promptInput: document.getElementById("promptInput"),
  newSessionButton: document.getElementById("newSessionButton"),
  sendButton: document.getElementById("sendButton"),
  resumeButton: document.getElementById("resumeButton"),
  cancelButton: document.getElementById("cancelButton"),
  sessionList: document.getElementById("sessionList"),
  openHistoryFolderButton: document.getElementById("openHistoryFolderButton"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
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

function hasTopbarSelections() {
  const workspace = elements.workspaceInput.value.trim() || state.cwd;
  const model = elements.modelInput.value || state.model;
  return Boolean(String(workspace || "").trim() && String(model || "").trim());
}

function createTopbarSummaryChip(text, options = {}) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "topbar-summary-chip";
  if (options.primary) {
    chip.classList.add("is-primary");
  }
  if (options.active) {
    chip.classList.add("is-active");
  }
  const value = document.createElement("span");
  value.className = "topbar-summary-value";
  value.textContent = text;
  chip.append(value);

  if (options.caption) {
    const caption = document.createElement("span");
    caption.className = "topbar-summary-caption";
    caption.textContent = options.caption;
    chip.append(caption);
  }

  if (options.title) {
    chip.title = options.title;
  }
  if (options.action) {
    chip.dataset.action = options.action;
    chip.setAttribute("aria-pressed", String(Boolean(options.active)));
    chip.addEventListener("click", async () => {
      await handleTopbarSummaryAction(options.action);
    });
  }
  return chip;
}

function renderTopbarSummary() {
  const workspace = elements.workspaceInput.value.trim() || state.cwd;
  const model = elements.modelInput.value || state.model;
  const turns = Math.max(1, Number.parseInt(elements.maxTurnsInput.value || "12", 10) || 12);
  const approvalLabel = elements.approveAllToggle.checked ? "Approve all" : "Manual approvals";
  const writesLabel = elements.previewWritesToggle.checked ? "Preview writes" : "Direct writes";
  const historyLabel = elements.storeHistoryToggle.checked ? "History on" : "History off";

  elements.topbarSummary.textContent = "";
  elements.topbarSummary.append(
    createTopbarSummaryChip(workspace ? formatWorkspaceLabel(workspace) : "Choose workspace", {
      action: "workspace",
      caption: "Directory",
      primary: true,
      title: workspace || "No workspace selected",
    }),
    createTopbarSummaryChip(model || "Choose model", {
      action: "model",
      caption: "Model",
      active: state.topbarQuickEditor === "model",
    }),
    createTopbarSummaryChip(`${turns} turns`, {
      action: "turns",
      caption: "Turns",
      active: state.topbarQuickEditor === "turns",
    }),
    createTopbarSummaryChip(approvalLabel, {
      action: "approveAll",
      caption: "Approvals",
      active: elements.approveAllToggle.checked,
    }),
    createTopbarSummaryChip(writesLabel, {
      action: "previewWrites",
      caption: "Writes",
      active: elements.previewWritesToggle.checked,
    }),
    createTopbarSummaryChip(historyLabel, {
      action: "storeHistory",
      caption: "History",
      active: elements.storeHistoryToggle.checked,
    }),
  );

  const canCollapse = hasTopbarSelections();
  elements.topbarCollapseButton.disabled = !canCollapse;
  elements.topbarExpandButton.disabled = !canCollapse;
}

function renderTopbarQuickEditor() {
  const showQuickEditor =
    state.topbarCollapsed && (state.topbarQuickEditor === "model" || state.topbarQuickEditor === "turns");

  elements.topbarQuickEditor.classList.toggle("hidden", !showQuickEditor);
  elements.topbarQuickModelField.classList.toggle("hidden", state.topbarQuickEditor !== "model");
  elements.topbarQuickTurnsField.classList.toggle("hidden", state.topbarQuickEditor !== "turns");

  if (state.topbarQuickEditor === "model") {
    elements.collapsedModelInput.value = elements.modelInput.value || state.model || "";
  }

  if (state.topbarQuickEditor === "turns") {
    elements.collapsedTurnsInput.value = elements.maxTurnsInput.value || "12";
  }
}

function setTopbarQuickEditor(nextEditor) {
  const normalized = nextEditor === "model" || nextEditor === "turns" ? nextEditor : null;
  state.topbarQuickEditor = state.topbarQuickEditor === normalized ? null : normalized;
  syncTopbarState();

  if (state.topbarQuickEditor === "model") {
    window.requestAnimationFrame(() => {
      elements.collapsedModelInput.focus();
    });
  }

  if (state.topbarQuickEditor === "turns") {
    window.requestAnimationFrame(() => {
      elements.collapsedTurnsInput.focus();
      elements.collapsedTurnsInput.select();
    });
  }
}

async function handleTopbarSummaryAction(action) {
  if (action === "workspace") {
    state.topbarQuickEditor = null;
    syncTopbarState();
    try {
      await chooseWorkspace();
    } catch (error) {
      setStatus(toErrorMessage(error));
    }
    return;
  }

  if (action === "model" || action === "turns") {
    setTopbarQuickEditor(action);
    return;
  }

  if (action === "approveAll") {
    elements.approveAllToggle.checked = !elements.approveAllToggle.checked;
    syncTopbarState();
    return;
  }

  if (action === "previewWrites") {
    elements.previewWritesToggle.checked = !elements.previewWritesToggle.checked;
    syncTopbarState();
    return;
  }

  if (action === "storeHistory") {
    elements.storeHistoryToggle.checked = !elements.storeHistoryToggle.checked;
    syncTopbarState();
  }
}

function applyTopbarCollapsed(collapsed) {
  const next = Boolean(collapsed) && hasTopbarSelections();
  state.topbarCollapsed = next;
  if (!next) {
    state.topbarQuickEditor = null;
  }
  elements.topbar.classList.toggle("is-collapsed", next);
  elements.topbarCollapseButton.setAttribute("aria-expanded", String(!next));
  elements.topbarExpandButton.setAttribute("aria-expanded", String(!next));
}

function loadTopbarPreference() {
  const raw = window.localStorage.getItem(TOPBAR_COLLAPSED_KEY);
  state.topbarCollapsedPreference = raw === "true";
  applyTopbarCollapsed(state.topbarCollapsedPreference);
}

function saveTopbarPreference() {
  window.localStorage.setItem(TOPBAR_COLLAPSED_KEY, String(state.topbarCollapsedPreference));
}

function setTopbarCollapsed(collapsed) {
  state.topbarCollapsedPreference = Boolean(collapsed);
  applyTopbarCollapsed(state.topbarCollapsedPreference);
  saveTopbarPreference();
}

function syncTopbarState() {
  renderTopbarSummary();
  applyTopbarCollapsed(state.topbarCollapsedPreference);
  renderTopbarQuickEditor();
}

function inspectorSplitBounds() {
  const paneHeight = elements.inspectorPane?.getBoundingClientRect().height || 0;
  const handleHeight = elements.inspectorResizeHandle?.getBoundingClientRect().height || 18;
  const usableHeight = Math.max(0, paneHeight - handleHeight);

  if (usableHeight <= 0) {
    return {
      min: 0.22,
      max: 0.78,
    };
  }

  const min = Math.min(0.45, INSPECTOR_MIN_PANEL_HEIGHT / usableHeight);
  const max = 1 - min;

  if (min >= max) {
    return {
      min: 0.5,
      max: 0.5,
    };
  }

  return { min, max };
}

function normalizeInspectorSplitRatio(ratio) {
  const numeric = Number.parseFloat(String(ratio));
  const fallback = Number.isFinite(numeric) ? numeric : DEFAULT_INSPECTOR_SPLIT;
  const bounds = inspectorSplitBounds();

  if (bounds.min === bounds.max) {
    return bounds.min;
  }

  return Math.min(bounds.max, Math.max(bounds.min, fallback));
}

function applyInspectorSplit(ratio) {
  const nextRatio = normalizeInspectorSplitRatio(ratio);
  state.inspectorSplitRatio = nextRatio;
  const bounds = inspectorSplitBounds();

  const topPercent = (nextRatio * 100).toFixed(2);
  const bottomPercent = ((1 - nextRatio) * 100).toFixed(2);
  if (elements.inspectorPane) {
    elements.inspectorPane.style.gridTemplateRows = `minmax(${INSPECTOR_MIN_PANEL_HEIGHT}px, ${topPercent}%) 18px minmax(${INSPECTOR_MIN_PANEL_HEIGHT}px, ${bottomPercent}%)`;
  }

  elements.inspectorResizeHandle?.setAttribute("aria-valuemin", String(Math.round(bounds.min * 100)));
  elements.inspectorResizeHandle?.setAttribute("aria-valuemax", String(Math.round(bounds.max * 100)));
  elements.inspectorResizeHandle?.setAttribute("aria-valuenow", String(Math.round(nextRatio * 100)));
}

function loadInspectorSplitPreference() {
  const raw = window.localStorage.getItem(INSPECTOR_SPLIT_KEY);
  applyInspectorSplit(raw ?? DEFAULT_INSPECTOR_SPLIT);
}

function saveInspectorSplitPreference() {
  window.localStorage.setItem(INSPECTOR_SPLIT_KEY, String(state.inspectorSplitRatio));
}

function startInspectorResize(event) {
  if (event.button !== 0 || !elements.inspectorPane || !elements.inspectorResizeHandle || state.inspectorCollapsed) {
    return;
  }

  event.preventDefault();
  const paneRect = elements.inspectorPane.getBoundingClientRect();
  const handleHeight = elements.inspectorResizeHandle.getBoundingClientRect().height || 18;
  const usableHeight = Math.max(1, paneRect.height - handleHeight);

  const updateFromClientY = (clientY) => {
    const offset = clientY - paneRect.top;
    applyInspectorSplit(offset / usableHeight);
  };

  document.body.classList.add("inspector-resizing");
  updateFromClientY(event.clientY);

  const onMove = (moveEvent) => {
    updateFromClientY(moveEvent.clientY);
  };

  const onUp = () => {
    document.body.classList.remove("inspector-resizing");
    saveInspectorSplitPreference();
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function nudgeInspectorSplit(delta) {
  applyInspectorSplit(state.inspectorSplitRatio + delta);
  saveInspectorSplitPreference();
}

function applyInspectorCollapsed(collapsed) {
  state.inspectorCollapsed = Boolean(collapsed);
  document.body.classList.toggle("detail-pane-collapsed", state.inspectorCollapsed);
  elements.inspectorToggleButton.textContent = state.inspectorCollapsed ? "Show Inspector" : "Hide Inspector";
  elements.inspectorToggleButton.setAttribute("aria-expanded", String(!state.inspectorCollapsed));
  if (!state.inspectorCollapsed) {
    window.requestAnimationFrame(() => {
      applyInspectorSplit(state.inspectorSplitRatio);
    });
  }
}

function loadInspectorPreference() {
  const raw = window.localStorage.getItem(INSPECTOR_COLLAPSED_KEY);
  state.inspectorCollapsedPreference = raw === null ? true : raw === "true";
  applyInspectorCollapsed(state.inspectorCollapsedPreference);
}

function saveInspectorPreference() {
  window.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, String(state.inspectorCollapsedPreference));
}

function setInspectorCollapsed(collapsed) {
  state.inspectorCollapsedPreference = Boolean(collapsed);
  applyInspectorCollapsed(state.inspectorCollapsedPreference);
  saveInspectorPreference();
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
  elements.newSessionButton.disabled = running;
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

function normalizeCommandPaletteText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function highlightCommandPaletteTarget(element) {
  if (!element) {
    return;
  }

  element.classList.add("is-command-target");
  window.setTimeout(() => {
    element.classList.remove("is-command-target");
  }, 1400);
}

function focusThreadFromPalette(threadId) {
  const context = state.threadContexts.get(threadId);
  if (!context) {
    return;
  }

  setActiveInspectorThread(threadId);
  context.section.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
  highlightCommandPaletteTarget(context.section);
}

function focusTimelineEntryFromPalette(threadId, entryId) {
  const record = getTimelineEntryRecord(threadId, entryId);
  if (!record) {
    focusThreadFromPalette(threadId);
    return;
  }

  const batch = record.element.closest(".timeline-batch");
  if (batch) {
    batch.open = true;
    if (batch.dataset.batchId) {
      state.timelineBatchOpen.add(batch.dataset.batchId);
    }
  }

  setActiveInspectorThread(threadId);
  const target = batch || record.element;
  target.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
  highlightCommandPaletteTarget(record.element);
}

function sameWorkspacePath(left, right) {
  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return normalize(left) === normalize(right);
}

async function openSessionFromUi(session, options = {}) {
  if (!desktopApi) {
    setStatus("Desktop IPC bridge is unavailable.");
    return null;
  }

  const loaded = await desktopApi.loadSession(session.cwd || state.cwd, session.id);
  if (!loaded) {
    setStatus("Could not load that session.");
    return null;
  }

  let workspaceStatusMessage = "";
  if (loaded.cwd && !sameWorkspacePath(loaded.cwd, state.cwd)) {
    try {
      const payload = await desktopApi.getBootstrap(loaded.cwd);
      applyConfigToUi(payload.cwd, payload.config, payload.sessions, payload.modelOptions, payload.projectNotes);
      if (state.workspaceThreadId) {
        updateThreadContext(state.workspaceThreadId, {
          subtitle: formatWorkspaceLabel(payload.cwd),
        });
      }
      await reloadWorkspaceBrowser();
      workspaceStatusMessage = ` Switched to ${formatWorkspaceLabel(payload.cwd)}.`;
    } catch (error) {
      workspaceStatusMessage = ` Loaded the session, but could not switch to ${formatWorkspaceLabel(loaded.cwd)}: ${toErrorMessage(error)}`;
    }
  }

  state.currentSessionId = loaded.id;
  state.branchSessionId = options.branch ? loaded.id : null;
  renderSessions();
  renderSessionTranscript(loaded.events);
  resetProgress();

  if (options.statusText) {
    setStatus(options.statusText);
  } else if (!options.suppressStatus) {
    setStatus(`Conversation restored.${workspaceStatusMessage}`.trim());
  }

  return loaded;
}

function buildThreadCommands() {
  const commands = [];
  for (const [threadId, context] of state.threadContexts.entries()) {
    commands.push({
      id: `thread:${threadId}`,
      group: "Timeline",
      title: context.titleElement.textContent || "Conversation thread",
      subtitle: context.metaElement.textContent || "Jump to timeline thread",
      keywords: `thread timeline ${context.statusElement.textContent || ""}`,
      priority: threadId === state.activeInspectorThreadId ? 46 : 72,
      badge: context.statusElement.textContent || "",
      execute: () => {
        focusThreadFromPalette(threadId);
      },
    });
  }
  return commands;
}

function buildApprovalCommands() {
  if (!Array.isArray(state.approvals) || state.approvals.length === 0) {
    return [];
  }

  const commands = [
    {
      id: "approval:latest",
      group: "Approval",
      title: `Jump to latest approval: ${state.approvals[0].toolName}`,
      subtitle: "Review the most recent pending approval request.",
      keywords: `approval latest ${state.approvals[0].toolName}`,
      priority: 12,
      badge: "Pending",
      execute: () => {
        focusTimelineEntryFromPalette(state.approvals[0].threadId, state.approvals[0].requestId);
      },
    },
  ];

  for (const approval of state.approvals.slice(0, 8)) {
    commands.push({
      id: `approval:${approval.requestId}`,
      group: "Approval",
      title: approval.toolName,
      subtitle: "Jump to this pending approval.",
      keywords: `approval ${approval.toolName} pending`,
      priority: 24,
      badge: "Pending",
      execute: () => {
        focusTimelineEntryFromPalette(approval.threadId, approval.requestId);
      },
    });
  }

  return commands;
}

function buildSessionCommands() {
  return state.sessions.flatMap((session, index) => {
    const title = session.lastUserPrompt || "Untitled session";
    const workspaceLabel = formatWorkspaceLabel(session.cwd);
    const baseKeywords = `${title} ${session.model} ${workspaceLabel} ${session.cwd} session restore branch ${session.updatedAt}`;
    return [
      {
        id: `session:open:${session.id}`,
        group: "Session",
        title,
        subtitle: `Open session · ${workspaceLabel} · ${session.model} · ${formatTime(session.updatedAt)}`,
        keywords: `${baseKeywords} open`,
        priority: state.currentSessionId === session.id ? 18 + index : 58 + index,
        badge: state.currentSessionId === session.id ? "Current" : "Session",
        execute: async () => {
          await openSessionFromUi(session);
        },
      },
      {
        id: `session:branch:${session.id}`,
        group: "Session",
        title: `Branch: ${title}`,
        subtitle: `Start the next run from this session as a new branch.`,
        keywords: `${baseKeywords} branch fork`,
        priority: 92 + index,
        badge: state.branchSessionId === session.id ? "Branching" : "Branch",
        disabled: state.running,
        execute: async () => {
          await branchSessionFromUi(session);
        },
      },
    ];
  });
}

function buildModelCommands() {
  return state.modelOptions.map((option, index) => ({
    id: `model:${option.id}`,
    group: "Model",
    title: option.label,
    subtitle: `${option.family} model${option.id === elements.modelInput.value ? " · current selection" : ""}`,
    keywords: `${option.label} ${option.id} ${option.family} model`,
    priority: option.id === elements.modelInput.value ? 16 : 100 + index,
    badge: option.id === elements.modelInput.value ? "Current" : option.family,
    execute: () => {
      elements.modelInput.value = option.id;
      elements.collapsedModelInput.value = option.id;
      state.model = option.id;
      syncTopbarState();
      setStatus(`Selected model ${option.label}.`);
    },
  }));
}

function collectSuggestedPaletteFiles() {
  const suggestions = [];
  if (state.selectedBrowserPath) {
    suggestions.push(state.selectedBrowserPath);
  }
  if (state.activeDiffFilePath) {
    suggestions.push(state.activeDiffFilePath);
  }

  const threadId = state.activeInspectorThreadId || [...state.threadContexts.keys()].pop();
  if (threadId) {
    const touched = state.threadTouchedFiles.get(threadId) || rebuildThreadTouchedFiles(threadId);
    suggestions.push(
      ...[...touched.values()]
        .sort((left, right) => right.order - left.order || left.path.localeCompare(right.path))
        .map((item) => item.path),
    );
  }

  return uniqueWorkspacePaths(suggestions);
}

function scoreCommandPaletteFile(path, query) {
  const normalizedPath = normalizeCommandPaletteText(path);
  const normalizedQuery = normalizeCommandPaletteText(query);
  if (!normalizedQuery) {
    return normalizedPath.length;
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.some((token) => !normalizedPath.includes(token))) {
    return Number.POSITIVE_INFINITY;
  }

  if (normalizedPath === normalizedQuery) {
    return 0;
  }
  if (normalizedPath.startsWith(normalizedQuery)) {
    return 10;
  }

  const lastSegment = normalizeCommandPaletteText(lastPathSegment(path));
  if (lastSegment === normalizedQuery) {
    return 6;
  }
  if (lastSegment.startsWith(normalizedQuery)) {
    return 12;
  }
  if (lastSegment.includes(normalizedQuery)) {
    return 20;
  }

  return normalizedPath.indexOf(normalizedQuery) + 40;
}

function buildFileCommands(query) {
  const normalizedQuery = normalizeCommandPaletteText(query);
  const source = normalizedQuery ? state.commandPaletteFiles : collectSuggestedPaletteFiles();
  const ranked = [...source]
    .map((path) => ({
      path,
      score: scoreCommandPaletteFile(path, normalizedQuery),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, normalizedQuery ? 16 : 8);

  return ranked.map(({ path }, index) => ({
    id: `file:${path}`,
    group: "File",
    title: lastPathSegment(path),
    subtitle: path,
    keywords: `${path} file preview browser`,
    priority: 34 + index,
    badge: "File",
    execute: async () => {
      setInspectorCollapsed(false);
      setInspectorTab("browser");
      await previewWorkspaceFile(path);
      setStatus(`Opened ${path}.`);
    },
  }));
}

function buildActionCommands() {
  return [
    {
      id: "action:new-session",
      group: "Action",
      title: "Start New Session",
      subtitle: "Clear the active conversation and begin fresh in this workspace.",
      keywords: "new session fresh reset conversation clear current chat",
      priority: -4,
      badge: "Session",
      disabled: state.running,
      execute: () => {
        startNewSessionFromUi();
      },
    },
    {
      id: "action:toggle-inspector",
      group: "Action",
      title: state.inspectorCollapsed ? "Show Inspector" : "Hide Inspector",
      subtitle: "Toggle the workspace and diff sidebar.",
      keywords: "inspector sidebar panel toggle",
      priority: 0,
      badge: "Action",
      execute: () => {
        setInspectorCollapsed(!state.inspectorCollapsed);
      },
    },
    {
      id: "action:browser",
      group: "Action",
      title: "Open Workspace Browser",
      subtitle: "Show the inspector and focus the workspace tree.",
      keywords: "workspace browser files tree inspector",
      priority: 4,
      badge: "Workspace",
      execute: () => {
        setInspectorCollapsed(false);
        setInspectorTab("browser");
      },
    },
    {
      id: "action:working-set",
      group: "Action",
      title: "Open Working Set",
      subtitle: "Show files touched in the active thread.",
      keywords: "working set touched files inspector",
      priority: 8,
      badge: "Workspace",
      execute: () => {
        setInspectorCollapsed(false);
        setInspectorTab("working-set");
      },
    },
    {
      id: "action:notes",
      group: "Action",
      title: "Open Project Notes",
      subtitle: "Show the workspace memory notes surface.",
      keywords: "project notes memory inspector",
      priority: 10,
      badge: "Workspace",
      execute: () => {
        setInspectorCollapsed(false);
        setInspectorTab("notes");
      },
    },
    {
      id: "action:focus-prompt",
      group: "Action",
      title: "Focus Prompt Composer",
      subtitle: "Jump to the prompt box and keep typing.",
      keywords: "prompt composer input chat ask",
      priority: 14,
      badge: "Action",
      execute: () => {
        elements.promptInput.focus();
      },
    },
    {
      id: "action:open-history",
      group: "Action",
      title: "Open History Folder",
      subtitle: "Open this workspace's saved session folder.",
      keywords: "history folder sessions open",
      priority: 20,
      badge: "History",
      execute: async () => {
        await openHistoryFolderFromUi();
      },
    },
    {
      id: "action:refresh-workspace",
      group: "Action",
      title: "Refresh Workspace State",
      subtitle: "Reload sessions, config, and the workspace browser.",
      keywords: "refresh workspace sessions browser reload",
      priority: 28,
      badge: "Action",
      execute: async () => {
        await reloadWorkspaceState();
      },
    },
    {
      id: "action:choose-workspace",
      group: "Action",
      title: "Choose Workspace",
      subtitle: "Pick a different repository or folder.",
      keywords: "workspace folder choose switch",
      priority: 32,
      badge: "Action",
      execute: async () => {
        await chooseWorkspace();
      },
    },
  ];
}

function scoreCommandPaletteItem(item, query) {
  const normalizedQuery = normalizeCommandPaletteText(query);
  if (!normalizedQuery) {
    return item.priority ?? 1000;
  }

  const title = normalizeCommandPaletteText(item.title);
  const haystack = normalizeCommandPaletteText(
    `${item.title} ${item.subtitle || ""} ${item.keywords || ""} ${item.group || ""} ${item.badge || ""}`,
  );
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.some((token) => !haystack.includes(token))) {
    return Number.POSITIVE_INFINITY;
  }

  let score = item.priority ?? 1000;
  if (title === normalizedQuery) {
    score -= 500;
  } else if (title.startsWith(normalizedQuery)) {
    score -= 300;
  } else if (title.includes(normalizedQuery)) {
    score -= 180;
  } else if (haystack.includes(normalizedQuery)) {
    score -= 80;
  }

  const titleIndex = title.indexOf(normalizedQuery);
  if (titleIndex >= 0) {
    score += titleIndex;
  } else {
    score += haystack.indexOf(normalizedQuery) + 40;
  }

  return score;
}

function getCommandPaletteItems() {
  const query = state.commandPaletteQuery;
  const commands = [
    ...buildActionCommands(),
    ...buildApprovalCommands(),
    ...buildSessionCommands(),
    ...buildThreadCommands(),
    ...buildModelCommands(),
    ...buildFileCommands(query),
  ]
    .map((item) => ({
      ...item,
      score: scoreCommandPaletteItem(item, query),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.title.localeCompare(right.title));

  return commands.slice(0, 16);
}

function renderCommandPalette() {
  elements.commandPalette.classList.toggle("hidden", !state.commandPaletteOpen);
  document.body.classList.toggle("command-palette-open", state.commandPaletteOpen);
  if (!state.commandPaletteOpen) {
    elements.commandPaletteInput.removeAttribute("aria-activedescendant");
    return;
  }

  const items = getCommandPaletteItems();
  state.commandPaletteResults = items;
  state.commandPaletteSelectedIndex = Math.max(0, Math.min(state.commandPaletteSelectedIndex, Math.max(0, items.length - 1)));
  elements.commandPaletteResults.textContent = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = state.commandPaletteLoading
      ? "Indexing workspace files..."
      : "No matching commands. Try a file path, session title, model name, or action.";
    elements.commandPaletteResults.append(empty);
  } else {
    items.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "command-palette-item";
      button.id = `commandPaletteItem-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === state.commandPaletteSelectedIndex));
      button.disabled = Boolean(item.disabled);
      if (index === state.commandPaletteSelectedIndex) {
        button.classList.add("is-active");
      }
      if (item.disabled) {
        button.classList.add("is-disabled");
      }

      const header = document.createElement("div");
      header.className = "command-palette-item-header";

      const group = document.createElement("span");
      group.className = "command-palette-item-group";
      group.textContent = item.group;

      const badge = document.createElement("span");
      badge.className = "command-palette-item-badge";
      badge.textContent = item.badge || item.group;

      header.append(group, badge);

      const title = document.createElement("strong");
      title.textContent = item.title;

      const subtitle = document.createElement("span");
      subtitle.className = "command-palette-item-subtitle";
      subtitle.textContent = item.subtitle || "";

      button.append(header, title, subtitle);
      button.addEventListener("mousemove", () => {
        state.commandPaletteSelectedIndex = index;
        renderCommandPalette();
      });
      button.addEventListener("click", async () => {
        await executeCommandPaletteItem(index);
      });
      elements.commandPaletteResults.append(button);
    });
  }

  const activeItemId = items[state.commandPaletteSelectedIndex]
    ? `commandPaletteItem-${state.commandPaletteSelectedIndex}`
    : "";
  if (activeItemId) {
    elements.commandPaletteInput.setAttribute("aria-activedescendant", activeItemId);
  } else {
    elements.commandPaletteInput.removeAttribute("aria-activedescendant");
  }

  if (state.commandPaletteLoading) {
    elements.commandPaletteMeta.textContent = `Searching commands. Indexing workspace files for quick file jumps${state.commandPaletteFiles.length > 0 ? ` · ${pluralize(state.commandPaletteFiles.length, "file")} cached` : ""}.`;
  } else {
    const fileStatus = state.commandPaletteWorkspacePath === state.cwd && state.commandPaletteFiles.length > 0
      ? ` · ${pluralize(state.commandPaletteFiles.length, "file")} indexed`
      : "";
    elements.commandPaletteMeta.textContent = `${pluralize(items.length, "result")} shown${fileStatus}. Use arrow keys and Enter.`;
  }

  elements.commandPaletteResults.querySelector(".command-palette-item.is-active")?.scrollIntoView({
    block: "nearest",
  });
}

async function executeCommandPaletteItem(index = state.commandPaletteSelectedIndex) {
  const item = state.commandPaletteResults[index];
  if (!item || item.disabled) {
    return;
  }

  closeCommandPalette();
  await item.execute();
}

function closeCommandPalette() {
  state.commandPaletteOpen = false;
  renderCommandPalette();
}

function moveCommandPaletteSelection(delta) {
  const itemCount = state.commandPaletteResults.length;
  if (itemCount === 0) {
    state.commandPaletteSelectedIndex = 0;
    renderCommandPalette();
    return;
  }

  const nextIndex = Math.max(0, Math.min(itemCount - 1, state.commandPaletteSelectedIndex + delta));
  if (nextIndex === state.commandPaletteSelectedIndex) {
    return;
  }

  state.commandPaletteSelectedIndex = nextIndex;
  renderCommandPalette();
}

function invalidateCommandPaletteFileIndex() {
  state.commandPaletteWorkspacePath = "";
  state.commandPaletteFiles = [];
  state.commandPaletteLoading = false;
  state.commandPaletteToken += 1;
}

function openCommandPalette(initialQuery = "") {
  state.commandPaletteOpen = true;
  state.commandPaletteSelectedIndex = 0;
  state.commandPaletteQuery = String(initialQuery || "");
  elements.commandPaletteInput.value = state.commandPaletteQuery;
  renderCommandPalette();
  void ensureCommandPaletteFileIndex();
  window.requestAnimationFrame(() => {
    elements.commandPaletteInput.focus();
    elements.commandPaletteInput.select();
  });
}

function toggleCommandPalette() {
  if (state.commandPaletteOpen) {
    closeCommandPalette();
    return;
  }
  openCommandPalette();
}

async function ensureCommandPaletteFileIndex(force = false) {
  if (!desktopApi || !state.cwd) {
    return [];
  }

  if (!force && state.commandPaletteWorkspacePath === state.cwd && state.commandPaletteFiles.length > 0) {
    return state.commandPaletteFiles;
  }

  const token = Date.now();
  state.commandPaletteToken = token;
  state.commandPaletteLoading = true;
  if (force) {
    state.commandPaletteFiles = [];
  }
  renderCommandPalette();

  try {
    const files = [];
    const queue = [""];
    const visited = new Set();

    while (queue.length > 0 && files.length < COMMAND_PALETTE_FILE_LIMIT) {
      const relativePath = queue.shift();
      if (visited.has(relativePath)) {
        continue;
      }
      visited.add(relativePath);

      let entries = state.workspaceTreeEntries.get(relativePath);
      if (!entries) {
        const payload = await desktopApi.listWorkspaceTree(state.cwd, relativePath);
        entries = Array.isArray(payload?.entries)
          ? payload.entries.map((entry) => ({
              ...entry,
              path: normalizeWorkspaceRelativePath(entry.path),
            }))
          : [];
        state.workspaceTreeEntries.set(relativePath, entries);
      }

      for (const entry of entries) {
        const normalized = normalizeWorkspaceRelativePath(entry.path);
        if (!normalized) {
          continue;
        }
        if (entry.type === "directory") {
          queue.push(normalized);
          continue;
        }
        files.push(normalized);
        if (files.length >= COMMAND_PALETTE_FILE_LIMIT) {
          break;
        }
      }
    }

    if (state.commandPaletteToken !== token) {
      return state.commandPaletteFiles;
    }

    state.commandPaletteFiles = files.sort((left, right) => left.localeCompare(right));
    state.commandPaletteWorkspacePath = state.cwd;
    state.commandPaletteLoading = false;
    renderCommandPalette();
    return state.commandPaletteFiles;
  } catch (error) {
    if (state.commandPaletteToken === token) {
      state.commandPaletteLoading = false;
      renderCommandPalette();
      setStatus(toErrorMessage(error));
    }
    return state.commandPaletteFiles;
  }
}

function normalizeWorkspaceRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized || normalized === ".") {
    return "";
  }

  let next = normalized;
  const cwd = String(state.cwd || "").replace(/\\/g, "/").trim();
  if (cwd && (next === cwd || next.startsWith(`${cwd}/`))) {
    next = next.slice(cwd.length).replace(/^\/+/, "");
  }

  while (next.startsWith("./")) {
    next = next.slice(2);
  }

  if (!next || next === "." || next.startsWith("../")) {
    return "";
  }

  return next;
}

function uniqueWorkspacePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeWorkspaceRelativePath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parentWorkspacePath(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized || !normalized.includes("/")) {
    return "";
  }
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function workspaceAncestors(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) {
    return [];
  }

  const parts = normalized.split("/");
  const result = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("/"));
  }
  return result;
}

function stripDiffPathPrefix(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/dev/null") {
    return "";
  }

  const withoutQuotes = trimmed.replace(/^"(.*)"$/, "$1");
  if (withoutQuotes.startsWith("a/") || withoutQuotes.startsWith("b/")) {
    return normalizeWorkspaceRelativePath(withoutQuotes.slice(2));
  }

  return normalizeWorkspaceRelativePath(withoutQuotes);
}

function parseUnifiedDiff(diffText) {
  const raw = String(diffText || "").replace(/\r\n/g, "\n").trim();
  if (!raw) {
    return {
      raw: "",
      files: [],
      changedPaths: [],
    };
  }

  const lines = raw.split("\n");
  const files = [];
  let current = null;

  function ensureCurrent() {
    if (current) {
      return current;
    }

    current = {
      path: "",
      oldPath: "",
      newPath: "",
      status: "modified",
      headerLines: [],
      hunks: [],
      rawLines: [],
    };
    return current;
  }

  function pushCurrent() {
    if (!current) {
      return;
    }

    const fallbackPath = current.newPath || current.oldPath || current.path || "";
    current.path = normalizeWorkspaceRelativePath(fallbackPath);

    if (current.status === "modified") {
      if (!current.oldPath && current.newPath) {
        current.status = "added";
      } else if (current.oldPath && !current.newPath) {
        current.status = "deleted";
      } else if (current.oldPath && current.newPath && current.oldPath !== current.newPath) {
        current.status = "renamed";
      }
    }

    files.push(current);
    current = null;
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        path: "",
        oldPath: stripDiffPathPrefix(match?.[1] || ""),
        newPath: stripDiffPathPrefix(match?.[2] || ""),
        status: "modified",
        headerLines: [line],
        hunks: [],
        rawLines: [line],
      };
      continue;
    }

    const target = ensureCurrent();
    target.rawLines.push(line);

    if (line.startsWith("new file mode ")) {
      target.status = "added";
      target.headerLines.push(line);
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      target.status = "deleted";
      target.headerLines.push(line);
      continue;
    }

    if (line.startsWith("rename from ")) {
      target.status = "renamed";
      target.oldPath = normalizeWorkspaceRelativePath(line.slice("rename from ".length));
      target.headerLines.push(line);
      continue;
    }

    if (line.startsWith("rename to ")) {
      target.status = "renamed";
      target.newPath = normalizeWorkspaceRelativePath(line.slice("rename to ".length));
      target.headerLines.push(line);
      continue;
    }

    if (line.startsWith("--- ")) {
      target.oldPath = stripDiffPathPrefix(line.slice(4).trim().split(/\s+/)[0]);
      target.headerLines.push(line);
      continue;
    }

    if (line.startsWith("+++ ")) {
      target.newPath = stripDiffPathPrefix(line.slice(4).trim().split(/\s+/)[0]);
      target.headerLines.push(line);
      continue;
    }

    if (line.startsWith("@@")) {
      target.hunks.push({
        header: line,
        lines: [],
      });
      continue;
    }

    if (target.hunks.length > 0) {
      target.hunks[target.hunks.length - 1].lines.push(line);
    } else {
      target.headerLines.push(line);
    }
  }

  pushCurrent();

  const changedPaths = uniqueWorkspacePaths(files.map((file) => file.path || file.newPath || file.oldPath).filter(Boolean));
  return {
    raw,
    files,
    changedPaths,
  };
}

function buildSplitDiffRows(file) {
  const rows = [];

  for (const hunk of file.hunks) {
    rows.push({
      type: "hunk",
      text: hunk.header,
    });

    const removals = [];
    const additions = [];

    function flushChanges() {
      const maxRows = Math.max(removals.length, additions.length);
      for (let index = 0; index < maxRows; index += 1) {
        const left = removals[index];
        const right = additions[index];
        rows.push({
          type: "change",
          left: left ?? "",
          right: right ?? "",
          leftTone: left === undefined ? "empty" : "remove",
          rightTone: right === undefined ? "empty" : "add",
        });
      }
      removals.length = 0;
      additions.length = 0;
    }

    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        removals.push(line.slice(1));
        continue;
      }

      if (line.startsWith("+")) {
        additions.push(line.slice(1));
        continue;
      }

      flushChanges();

      if (line.startsWith(" ")) {
        rows.push({
          type: "context",
          left: line.slice(1),
          right: line.slice(1),
          leftTone: "context",
          rightTone: "context",
        });
        continue;
      }

      rows.push({
        type: "note",
        text: line,
      });
    }

    flushChanges();
  }

  return rows;
}

function collectToolResultFiles(toolCall, result, diffInfo) {
  const metadata = result?.metadata || {};
  const files = [];

  if (typeof metadata.path === "string") {
    files.push(metadata.path);
  }

  if (Array.isArray(metadata.paths)) {
    files.push(...metadata.paths);
  }

  if (Array.isArray(metadata.files)) {
    files.push(...metadata.files);
  }

  if (Array.isArray(toolCall?.arguments?.paths) && ["read_many_files"].includes(toolCall.name)) {
    files.push(...toolCall.arguments.paths);
  }

  if (typeof toolCall?.arguments?.path === "string" && ["read_file", "write_file", "create_file", "inspect_path"].includes(toolCall.name)) {
    files.push(toolCall.arguments.path);
  }

  if (diffInfo?.changedPaths?.length) {
    files.push(...diffInfo.changedPaths);
  }

  return uniqueWorkspacePaths(files);
}

function collectApprovalFiles(approval, diffInfo) {
  const files = [];

  if (diffInfo?.changedPaths?.length) {
    files.push(...diffInfo.changedPaths);
  }

  return uniqueWorkspacePaths(files);
}

function renderInspectorTabs() {
  elements.inspectorTabs.textContent = "";
  for (const tab of INSPECTOR_TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button inspector-tab-button";
    button.textContent = tab.label;
    button.dataset.tab = tab.id;
    button.classList.toggle("is-active", state.inspectorTab === tab.id);
    button.setAttribute("aria-pressed", String(state.inspectorTab === tab.id));
    button.addEventListener("click", () => {
      setInspectorTab(tab.id);
    });
    elements.inspectorTabs.append(button);
  }

  elements.browserToolbar.classList.toggle("hidden", state.inspectorTab !== "browser");
  elements.projectNotesToolbar.classList.toggle("hidden", state.inspectorTab !== "notes");
  elements.browserView.classList.toggle("hidden", state.inspectorTab !== "browser");
  elements.workingSetView.classList.toggle("hidden", state.inspectorTab !== "working-set");
  elements.projectNotesView.classList.toggle("hidden", state.inspectorTab !== "notes");
}

function rebuildThreadTouchedFiles(threadId) {
  if (!threadId) {
    return new Map();
  }

  const touched = new Map();
  let order = 0;

  for (const [key, value] of state.activityEntryMap.entries()) {
    if (!key.startsWith(`${threadId}:`)) {
      continue;
    }

    order += 1;
    const entry = value.entry;
    const files = Array.isArray(entry.files) ? entry.files : [];
    if (files.length === 0) {
      continue;
    }

    const diffPaths = entry.diffInfo?.changedPaths || [];

    for (const path of files) {
      const existing = touched.get(path) || {
        path,
        count: 0,
        title: "",
        label: "",
        meta: "",
        category: "",
        order: 0,
        diffEntry: null,
      };

      existing.count += 1;
      existing.title = entry.title;
      existing.label = entry.label;
      existing.meta = entry.meta;
      existing.category = entry.category;
      existing.order = order;

      if (entry.diff && (diffPaths.includes(path) || diffPaths.length === 1)) {
        existing.diffEntry = entry;
      }

      touched.set(path, existing);
    }
  }

  state.threadTouchedFiles.set(threadId, touched);
  return touched;
}

function renderInspectorContext() {
  const workspaceLabel = state.cwd ? formatWorkspaceLabel(state.cwd) : "workspace";
  const context = state.activeInspectorThreadId ? state.threadContexts.get(state.activeInspectorThreadId) : null;
  const touched = state.activeInspectorThreadId
    ? state.threadTouchedFiles.get(state.activeInspectorThreadId) || rebuildThreadTouchedFiles(state.activeInspectorThreadId)
    : new Map();

  if (state.inspectorTab === "notes") {
    if (!state.cwd) {
      elements.inspectorContext.textContent = "Choose a workspace to load project notes.";
      return;
    }

    elements.inspectorContext.textContent = state.projectNotesIncludeInPrompt
      ? `Project notes for ${workspaceLabel}. This memo is injected into new runs for the workspace.`
      : `Project notes for ${workspaceLabel}. They are saved, but currently excluded from new runs.`;
    return;
  }

  if (state.inspectorTab === "working-set") {
    if (context) {
      elements.inspectorContext.textContent = `${context.titleElement.textContent} · ${pluralize(touched.size, "touched file")}.`;
    } else {
      elements.inspectorContext.textContent = "No active thread yet.";
    }
    return;
  }

  if (context && touched.size > 0) {
    elements.inspectorContext.textContent = `Browsing ${workspaceLabel}. ${pluralize(touched.size, "touched file")} from ${context.titleElement.textContent}.`;
    return;
  }

  elements.inspectorContext.textContent = `Browse ${workspaceLabel}, inspect files, and jump into diffs.`;
}

function setInspectorTab(tabId) {
  const nextTab = INSPECTOR_TABS.some((tab) => tab.id === tabId) ? tabId : "browser";
  state.inspectorTab = nextTab;
  renderInspectorTabs();
  renderInspectorContext();
}

function setActiveInspectorThread(threadId) {
  const nextThreadId = threadId && state.threadContexts.has(threadId) ? threadId : null;
  state.activeInspectorThreadId = nextThreadId;

  for (const [candidateId, context] of state.threadContexts.entries()) {
    const isActive = candidateId === nextThreadId;
    context.section.classList.toggle("is-active", isActive);
    context.header.classList.toggle("is-active", isActive);
    context.header.setAttribute("aria-pressed", String(isActive));
  }

  if (nextThreadId) {
    rebuildThreadTouchedFiles(nextThreadId);
  }

  renderWorkingSet();
  renderInspectorContext();
}

function findWorkspaceEntry(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const parentPath = parentWorkspacePath(normalized);
  const candidates = state.workspaceTreeEntries.get(parentPath) || [];
  return candidates.find((entry) => entry.path === normalized) || null;
}

function setBrowserPreviewState(preview) {
  state.browserPreview = preview;
  renderFilePreview();
}

function createFilePreviewMediaNode(kind, source, label) {
  const src = resolveMediaSource(source);
  if (!src) {
    return null;
  }

  if (kind === "image") {
    const image = document.createElement("img");
    image.className = "file-preview-media is-image";
    image.src = src;
    image.alt = label || "Preview image";
    image.loading = "lazy";
    return image;
  }

  if (kind === "video") {
    const video = document.createElement("video");
    video.className = "file-preview-media is-video";
    video.src = src;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    return video;
  }

  if (kind === "audio") {
    const audio = document.createElement("audio");
    audio.className = "file-preview-media is-audio";
    audio.src = src;
    audio.controls = true;
    audio.preload = "metadata";
    return audio;
  }

  return null;
}

function projectNotesDirty() {
  return (
    state.projectNotesContent !== state.projectNotesSavedContent ||
    state.projectNotesIncludeInPrompt !== state.projectNotesSavedIncludeInPrompt
  );
}

function applyProjectNotesPayload(payload) {
  state.projectNotesPath = String(payload?.path || "");
  state.projectNotesContent = String(payload?.content || "");
  state.projectNotesSavedContent = String(payload?.content || "");
  state.projectNotesExists = Boolean(payload?.exists);
  state.projectNotesIncludeInPrompt = payload?.includeInPrompt !== false;
  state.projectNotesSavedIncludeInPrompt = payload?.includeInPrompt !== false;
  state.projectNotesIsCustomPath = Boolean(payload?.isCustomPath);
  state.projectNotesSaving = false;
  renderProjectNotes();
  renderInspectorContext();
}

function renderProjectNotes() {
  const hasWorkspace = Boolean(state.cwd);
  const dirty = projectNotesDirty();
  const notePath = state.projectNotesPath || "Choose a workspace to create notes.";

  if (elements.projectNotesInput.value !== state.projectNotesContent) {
    elements.projectNotesInput.value = state.projectNotesContent;
  }

  elements.projectNotesPath.textContent = notePath;
  elements.projectNotesPath.title = state.projectNotesPath || "";
  elements.projectNotesIncludeToggle.checked = state.projectNotesIncludeInPrompt;
  elements.projectNotesIncludeToggle.disabled = !hasWorkspace || state.projectNotesSaving;
  elements.projectNotesIncludeToggle.closest(".project-notes-toggle")?.classList.toggle(
    "is-disabled",
    !hasWorkspace || state.projectNotesSaving,
  );
  elements.projectNotesInput.disabled = !hasWorkspace || state.projectNotesSaving;
  elements.openProjectNotesButton.disabled = !hasWorkspace;
  elements.saveProjectNotesButton.disabled = !hasWorkspace || state.projectNotesSaving || !dirty;
  elements.saveProjectNotesButton.textContent = state.projectNotesSaving ? "Saving..." : "Save Notes";

  let stateLabel = "Saved";
  let stateTone = "saved";
  let hint = "Capture durable context like architecture, constraints, preferred commands, and project-specific reminders.";

  if (!hasWorkspace) {
    stateLabel = "Unavailable";
    stateTone = "muted";
    hint = "Choose a workspace to load or create project notes.";
  } else if (state.projectNotesSaving) {
    stateLabel = "Saving";
    stateTone = "active";
    hint = "Writing the latest notes to disk for this workspace.";
  } else if (dirty) {
    stateLabel = "Unsaved";
    stateTone = "dirty";
    hint = "Save to update the workspace memory used in future runs.";
  } else if (!state.projectNotesIncludeInPrompt) {
    stateLabel = "Paused";
    stateTone = "muted";
    hint = "Notes are saved, but they are currently excluded from new runs.";
  } else if (!state.projectNotesContent.trim()) {
    stateLabel = "Empty";
    stateTone = "muted";
    hint = "Start this memo with architecture, preferred commands, constraints, or recurring pitfalls.";
  } else if (state.projectNotesIsCustomPath) {
    stateLabel = "Custom path";
    stateTone = "saved";
    hint = "These notes are loaded from a custom project notes path and injected into new runs.";
  } else {
    hint = "These notes are injected into new runs so the workspace keeps its memory over time.";
  }

  elements.projectNotesState.textContent = stateLabel;
  elements.projectNotesState.dataset.tone = stateTone;
  elements.projectNotesHint.textContent = hint;
}

function renderFilePreview() {
  elements.filePreview.textContent = "";

  const selectedPath = normalizeWorkspaceRelativePath(state.selectedBrowserPath);
  elements.openSelectedFileButton.disabled = !selectedPath;

  if (state.browserPreviewLoading) {
    createEmptyState(elements.filePreview, "Loading preview...");
    return;
  }

  if (!selectedPath) {
    createEmptyState(elements.filePreview, "Select a file in the tree or from the timeline to preview it here.");
    return;
  }

  if (!state.browserPreview) {
    createEmptyState(elements.filePreview, "Select a file in the tree or from the timeline to preview it here.");
    return;
  }

  clearEmptyState(elements.filePreview);

  const header = document.createElement("div");
  header.className = "file-preview-header";

  const title = document.createElement("strong");
  title.textContent = state.browserPreview.path || selectedPath;

  const meta = document.createElement("span");
  if (state.browserPreview.error) {
    meta.textContent = "Preview unavailable";
  } else if (state.browserPreview.message) {
    meta.textContent = "Selection";
  } else {
    const details = [];
    if (typeof state.browserPreview.size === "number") {
      details.push(`${state.browserPreview.size.toLocaleString()} bytes`);
    }
    if (state.browserPreview.truncated) {
      details.push("truncated");
    }
    if (state.browserPreview.isBinary) {
      details.push("binary");
    }
    meta.textContent = details.join(" · ") || "Preview";
  }

  header.append(title, meta);
  elements.filePreview.append(header);

  if (state.browserPreview.error || state.browserPreview.message) {
    const notice = document.createElement("div");
    notice.className = state.browserPreview.error ? "file-preview-note is-error" : "file-preview-note";
    notice.textContent = state.browserPreview.error || state.browserPreview.message;
    elements.filePreview.append(notice);
    return;
  }

  const mediaKind = inferMediaKind(
    state.browserPreview.absolutePath || state.browserPreview.path || selectedPath,
  );
  if (mediaKind) {
    const mediaNode = createFilePreviewMediaNode(
      mediaKind,
      state.browserPreview.absolutePath || state.browserPreview.path || selectedPath,
      state.browserPreview.path || selectedPath,
    );
    if (mediaNode) {
      elements.filePreview.append(mediaNode);
      return;
    }
  }

  if (state.browserPreview.isBinary) {
    const binaryNotice = document.createElement("div");
    binaryNotice.className = "file-preview-note";
    binaryNotice.textContent = "This file looks binary, so the inline preview is hidden.";
    elements.filePreview.append(binaryNotice);
    return;
  }

  const body = document.createElement("pre");
  body.className = "file-preview-body";
  body.textContent = state.browserPreview.content || "";
  elements.filePreview.append(body);
}

async function loadWorkspaceDirectory(relativePath = "") {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!desktopApi || !state.cwd) {
    return [];
  }

  if (state.workspaceTreeEntries.has(normalized)) {
    return state.workspaceTreeEntries.get(normalized) || [];
  }

  if (state.workspaceTreeLoading.has(normalized)) {
    return [];
  }

  state.workspaceTreeLoading.add(normalized);
  renderWorkspaceTree();

  try {
    const payload = await desktopApi.listWorkspaceTree(state.cwd, normalized);
    const entries = Array.isArray(payload?.entries)
      ? payload.entries.map((entry) => ({
          ...entry,
          path: normalizeWorkspaceRelativePath(entry.path),
        }))
      : [];
    state.workspaceTreeEntries.set(normalized, entries);
    return entries;
  } catch (error) {
    setStatus(toErrorMessage(error));
    return [];
  } finally {
    state.workspaceTreeLoading.delete(normalized);
    renderWorkspaceTree();
  }
}

async function ensureWorkspaceTreeLoaded() {
  return loadWorkspaceDirectory("");
}

async function revealWorkspacePath(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  await ensureWorkspaceTreeLoaded();

  for (const ancestor of workspaceAncestors(normalized)) {
    state.expandedWorkspacePaths.add(ancestor);
    await loadWorkspaceDirectory(ancestor);
  }

  renderWorkspaceTree();
}

async function previewWorkspaceFile(relativePath, options = {}) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) {
    return;
  }

  if (options.expandInspector !== false) {
    setInspectorCollapsed(false);
  }

  if (options.switchTab !== false) {
    setInspectorTab("browser");
  }

  state.selectedBrowserPath = normalized;
  await revealWorkspacePath(normalized);

  const entry = findWorkspaceEntry(normalized);
  if (entry?.type === "directory") {
    setBrowserPreviewState({
      path: normalized,
      message: "Directory selected. Expand folders in the tree to inspect individual files.",
    });
    renderWorkspaceTree();
    return;
  }

  state.browserPreviewLoading = true;
  renderFilePreview();

  try {
    if (!desktopApi) {
      throw new Error("Desktop IPC bridge is unavailable.");
    }
    const preview = await desktopApi.readWorkspaceFile(state.cwd, normalized);
    setBrowserPreviewState({
      ...preview,
      path: normalizeWorkspaceRelativePath(preview.path || normalized) || normalized,
    });
  } catch (error) {
    setBrowserPreviewState({
      path: normalized,
      error: toErrorMessage(error),
    });
  } finally {
    state.browserPreviewLoading = false;
    renderWorkspaceTree();
    renderFilePreview();
  }
}

async function selectWorkspaceTreePath(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) {
    return;
  }

  const entry = findWorkspaceEntry(normalized);
  if (entry?.type === "directory") {
    state.selectedBrowserPath = normalized;
    setBrowserPreviewState({
      path: normalized,
      message: "Directory selected. Expand folders in the tree to inspect individual files.",
    });
    renderWorkspaceTree();
    return;
  }

  await previewWorkspaceFile(normalized);
}

async function toggleWorkspaceDirectory(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) {
    return;
  }

  if (state.expandedWorkspacePaths.has(normalized)) {
    state.expandedWorkspacePaths.delete(normalized);
    renderWorkspaceTree();
    return;
  }

  state.expandedWorkspacePaths.add(normalized);
  await loadWorkspaceDirectory(normalized);
}

function createWorkspaceTreeNode(entry) {
  const node = document.createElement("div");
  node.className = "workspace-tree-node";
  node.dataset.path = entry.path;

  const row = document.createElement("div");
  row.className = "workspace-tree-row";
  if (state.selectedBrowserPath === entry.path) {
    row.classList.add("is-selected");
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "workspace-tree-toggle";

  if (entry.type === "directory") {
    const expanded = state.expandedWorkspacePaths.has(entry.path);
    toggle.textContent = expanded ? "▾" : "▸";
    toggle.addEventListener("click", async (event) => {
      event.stopPropagation();
      await toggleWorkspaceDirectory(entry.path);
    });
  } else {
    toggle.classList.add("is-placeholder");
    toggle.disabled = true;
    toggle.textContent = "•";
  }

  const label = document.createElement("button");
  label.type = "button";
  label.className = `workspace-tree-label is-${entry.type}`;
  label.textContent = entry.name;
  label.title = entry.path;
  label.addEventListener("click", async () => {
    await selectWorkspaceTreePath(entry.path);
  });

  row.append(toggle, label);
  node.append(row);

  if (entry.type === "directory" && state.expandedWorkspacePaths.has(entry.path)) {
    const children = document.createElement("div");
    children.className = "workspace-tree-children";

    if (state.workspaceTreeLoading.has(entry.path)) {
      const loading = document.createElement("div");
      loading.className = "workspace-tree-loading";
      loading.textContent = "Loading...";
      children.append(loading);
    } else {
      const childEntries = state.workspaceTreeEntries.get(entry.path) || [];
      if (childEntries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "workspace-tree-loading";
        empty.textContent = "Empty folder";
        children.append(empty);
      } else {
        for (const child of childEntries) {
          children.append(createWorkspaceTreeNode(child));
        }
      }
    }

    node.append(children);
  }

  return node;
}

function renderWorkspaceTree() {
  elements.workspaceTree.textContent = "";

  if (!state.cwd) {
    createEmptyState(elements.workspaceTree, "Choose a workspace to load the browser.");
    return;
  }

  if (state.workspaceTreeLoading.has("") && !state.workspaceTreeEntries.has("")) {
    createEmptyState(elements.workspaceTree, "Loading workspace tree...");
    return;
  }

  const rootEntries = state.workspaceTreeEntries.get("") || [];
  if (rootEntries.length === 0) {
    createEmptyState(elements.workspaceTree, "No files available in this workspace browser.");
    return;
  }

  clearEmptyState(elements.workspaceTree);
  const fragment = document.createDocumentFragment();
  for (const entry of rootEntries) {
    fragment.append(createWorkspaceTreeNode(entry));
  }
  elements.workspaceTree.append(fragment);
}

async function reloadWorkspaceBrowser() {
  state.workspaceTreeEntries = new Map();
  state.workspaceTreeLoading = new Set();
  state.expandedWorkspacePaths = new Set([""]);
  state.selectedBrowserPath = null;
  state.browserPreview = null;
  state.browserPreviewLoading = false;
  invalidateCommandPaletteFileIndex();
  renderWorkspaceTree();
  renderFilePreview();

  if (!state.cwd || !desktopApi) {
    return;
  }

  await ensureWorkspaceTreeLoaded();
  if (state.commandPaletteOpen) {
    void ensureCommandPaletteFileIndex(true);
  }
}

async function saveProjectNotesFromUi() {
  if (!state.cwd || !desktopApi || state.projectNotesSaving) {
    return;
  }

  state.projectNotesSaving = true;
  renderProjectNotes();

  try {
    const payload = await desktopApi.saveProjectNotes(state.cwd, {
      content: state.projectNotesContent,
      includeInPrompt: state.projectNotesIncludeInPrompt,
    });
    applyProjectNotesPayload(payload);
    setStatus(
      state.projectNotesIncludeInPrompt
        ? "Project notes saved and will be used in new runs."
        : "Project notes saved, but they are currently excluded from new runs.",
    );
  } catch (error) {
    state.projectNotesSaving = false;
    renderProjectNotes();
    setStatus(toErrorMessage(error));
  }
}

async function openProjectNotesFromUi() {
  if (!state.cwd || !desktopApi) {
    return;
  }

  try {
    const result = await desktopApi.openProjectNotes(state.cwd);
    if (!result?.ok) {
      setStatus(result?.error || "Could not open the project notes file.");
      return;
    }
    setStatus(`Opened project notes: ${result.path}`);
  } catch (error) {
    setStatus(toErrorMessage(error));
  }
}

async function openWorkspacePath(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized || !desktopApi) {
    return;
  }

  const result = await desktopApi.openWorkspacePath(state.cwd, normalized);
  if (!result?.ok) {
    setStatus(result?.error || `Could not open ${normalized}.`);
  }
}

function createDiffSelection(threadId, entry, preferredPath = null) {
  const diffInfo = entry.diffInfo || parseUnifiedDiff(entry.diff);
  const files = Array.isArray(diffInfo.files) ? diffInfo.files : [];
  const changedPaths = uniqueWorkspacePaths([
    ...(diffInfo.changedPaths || []),
    ...((Array.isArray(entry.files) ? entry.files : [])),
  ]);

  return {
    threadId,
    entryId: entry.id,
    title: entry.title,
    label: entry.label,
    meta: entry.meta,
    statusLabel: entry.statusLabel,
    raw: entry.diff || "",
    files,
    changedPaths,
    preferredPath: normalizeWorkspaceRelativePath(preferredPath) || changedPaths[0] || files[0]?.path || null,
  };
}

function setActiveDiff(selection) {
  state.activeDiff = selection || null;
  state.activeDiffFilePath = selection?.preferredPath || null;
  renderDiffInspector();
}

function createDiffFileHeader(file) {
  const header = document.createElement("div");
  header.className = "diff-file-header";

  const title = document.createElement("strong");
  title.textContent = file.path || file.newPath || file.oldPath || "Diff";

  const meta = document.createElement("span");
  meta.textContent = file.status;

  header.append(title, meta);
  return header;
}

function createDiffLineNode(line) {
  const element = document.createElement("div");
  element.className = "diff-line";

  if (line.startsWith("+")) {
    element.classList.add("is-add");
  } else if (line.startsWith("-")) {
    element.classList.add("is-remove");
  } else if (line.startsWith("@@")) {
    element.classList.add("is-hunk");
  } else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    element.classList.add("is-meta");
  }

  element.textContent = line;
  return element;
}

function renderUnifiedDiffFile(file) {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-render-block";
  wrapper.append(createDiffFileHeader(file));

  const body = document.createElement("div");
  body.className = "diff-unified-view";
  for (const line of file.rawLines) {
    body.append(createDiffLineNode(line));
  }

  wrapper.append(body);
  return wrapper;
}

function renderSplitDiffFile(file) {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-render-block";
  wrapper.append(createDiffFileHeader(file));

  if (file.headerLines.length > 0) {
    const meta = document.createElement("pre");
    meta.className = "diff-file-meta";
    meta.textContent = file.headerLines.join("\n");
    wrapper.append(meta);
  }

  const grid = document.createElement("div");
  grid.className = "diff-split-grid";

  const headerRow = document.createElement("div");
  headerRow.className = "diff-split-header";
  headerRow.innerHTML = "<span>Before</span><span>After</span>";
  grid.append(headerRow);

  const rows = buildSplitDiffRows(file);
  for (const row of rows) {
    if (row.type === "hunk" || row.type === "note") {
      const note = document.createElement("div");
      note.className = `diff-split-row is-spanning ${row.type === "hunk" ? "is-hunk" : "is-note"}`;
      note.textContent = row.text;
      grid.append(note);
      continue;
    }

    const rowElement = document.createElement("div");
    rowElement.className = "diff-split-row";

    const left = document.createElement("pre");
    left.className = `diff-split-cell is-${row.leftTone}`;
    left.textContent = row.left;

    const right = document.createElement("pre");
    right.className = `diff-split-cell is-${row.rightTone}`;
    right.textContent = row.right;

    rowElement.append(left, right);
    grid.append(rowElement);
  }

  wrapper.append(grid);
  return wrapper;
}

function renderDiffInspector() {
  elements.diffUnifiedButton.classList.toggle("is-active", state.diffViewMode === "unified");
  elements.diffSplitButton.classList.toggle("is-active", state.diffViewMode === "split");

  const selection = state.activeDiff;
  if (!selection || !selection.raw) {
    elements.diffInspectorEmpty.classList.remove("hidden");
    elements.diffInspectorSurface.classList.add("hidden");
    elements.diffInspectorMeta.textContent = "Select an edit, approval, or file chip to inspect.";
    elements.diffPreviewFileButton.disabled = true;
    elements.diffOpenFileButton.disabled = true;
    return;
  }

  elements.diffInspectorEmpty.classList.add("hidden");
  elements.diffInspectorSurface.classList.remove("hidden");

  const fileCount = selection.files.length || selection.changedPaths.length;
  elements.diffInspectorMeta.textContent = [selection.title, selection.statusLabel, fileCount ? pluralize(fileCount, "file") : ""]
    .filter(Boolean)
    .join(" · ");

  elements.diffFileTabs.textContent = "";
  if (selection.files.length > 0) {
    const availablePaths = selection.files.map((file) => file.path || file.newPath || file.oldPath).filter(Boolean);
    if (!availablePaths.includes(state.activeDiffFilePath)) {
      state.activeDiffFilePath = availablePaths[0] || null;
    }

    for (const file of selection.files) {
      const path = file.path || file.newPath || file.oldPath;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "ghost-button diff-file-tab";
      tab.textContent = lastPathSegment(path);
      tab.title = path;
      tab.classList.toggle("is-active", state.activeDiffFilePath === path);
      tab.addEventListener("click", () => {
        state.activeDiffFilePath = path;
        renderDiffInspector();
      });
      elements.diffFileTabs.append(tab);
    }
  }

  elements.diffPreviewFileButton.disabled = !state.activeDiffFilePath;
  elements.diffOpenFileButton.disabled = !state.activeDiffFilePath;
  elements.diffInspectorContent.textContent = "";

  const activeFile =
    selection.files.find((file) => (file.path || file.newPath || file.oldPath) === state.activeDiffFilePath) ||
    selection.files[0] ||
    null;

  if (!activeFile) {
    const raw = document.createElement("pre");
    raw.className = "diff-raw-fallback";
    raw.textContent = selection.raw;
    elements.diffInspectorContent.append(raw);
    return;
  }

  elements.diffInspectorContent.append(
    state.diffViewMode === "split" ? renderSplitDiffFile(activeFile) : renderUnifiedDiffFile(activeFile),
  );
}

function renderWorkingSet() {
  elements.workingSetList.textContent = "";

  if (!state.activeInspectorThreadId) {
    elements.workingSetSummary.textContent = "Choose a thread to follow its working set.";
    createEmptyState(elements.workingSetList, "No active thread yet.");
    return;
  }

  const touched = state.threadTouchedFiles.get(state.activeInspectorThreadId) || rebuildThreadTouchedFiles(state.activeInspectorThreadId);
  const items = [...touched.values()].sort((left, right) => right.order - left.order || left.path.localeCompare(right.path));
  const threadContext = state.threadContexts.get(state.activeInspectorThreadId);
  elements.workingSetSummary.textContent = threadContext
    ? `${threadContext.titleElement.textContent} · ${pluralize(items.length, "touched file")}`
    : `${pluralize(items.length, "touched file")}`;

  if (items.length === 0) {
    createEmptyState(elements.workingSetList, "Files touched in this run will appear here.");
    return;
  }

  clearEmptyState(elements.workingSetList);

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "working-set-item";

    const pathButton = document.createElement("button");
    pathButton.type = "button";
    pathButton.className = "working-set-path";
    pathButton.textContent = item.path;
    pathButton.title = item.path;
    pathButton.addEventListener("click", async () => {
      await previewWorkspaceFile(item.path);
      setInspectorTab("browser");
    });

    const meta = document.createElement("div");
    meta.className = "working-set-meta";
    meta.textContent = [item.label, item.title, item.count > 1 ? `${item.count} touches` : "", item.meta].filter(Boolean).join(" · ");

    const actions = document.createElement("div");
    actions.className = "working-set-actions";

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "ghost-button";
    previewButton.textContent = "Preview";
    previewButton.addEventListener("click", async () => {
      await previewWorkspaceFile(item.path);
      setInspectorTab("browser");
    });
    actions.append(previewButton);

    if (item.diffEntry) {
      const diffButton = document.createElement("button");
      diffButton.type = "button";
      diffButton.className = "ghost-button";
      diffButton.textContent = "Inspect Diff";
      diffButton.addEventListener("click", () => {
        setInspectorCollapsed(false);
        setActiveDiff(createDiffSelection(state.activeInspectorThreadId, item.diffEntry, item.path));
      });
      actions.append(diffButton);
    }

    card.append(pathButton, meta, actions);
    elements.workingSetList.append(card);
  }
}

async function handleEntryFileChipClick(threadId, entry, filePath) {
  if (threadId) {
    setActiveInspectorThread(threadId);
  }

  setInspectorCollapsed(false);

  const normalized = normalizeWorkspaceRelativePath(filePath);
  if (!normalized) {
    return;
  }

  if (entry.diff && entry.diffInfo?.changedPaths?.includes(normalized)) {
    setActiveDiff(createDiffSelection(threadId, entry, normalized));
  }

  await previewWorkspaceFile(normalized);
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

  const maxTitleSize = 13.5;
  const minTitleSize = 8.5;
  const maxMetaSize = 10.5;
  const minMetaSize = 8;
  let titleSize = maxTitleSize;
  let metaSize = maxMetaSize;

  card.style.setProperty("--session-title-size", `${titleSize}px`);
  card.style.setProperty("--session-meta-size", `${metaSize}px`);

  for (let index = 0; index < 18; index += 1) {
    const titleLines = lineCountForElement(title);
    const metaTooTall = meta.some((item) => lineCountForElement(item) > 1);
    const titleTooTall = titleLines > 1;
    const contentTooTall = card.getBoundingClientRect().height > 172;

    if (!titleTooTall && !metaTooTall && !contentTooTall) {
      break;
    }

    if (titleTooTall || contentTooTall) {
      titleSize = Math.max(minTitleSize, titleSize - 0.5);
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

function escapeHtmlAttribute(value) {
  return escapeHtml(String(value || ""));
}

function stripMarkdownLinkTitle(rawTarget) {
  const trimmed = String(rawTarget || "").trim();
  if (!trimmed) {
    return "";
  }

  const withoutBrackets = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  const titleMatch = withoutBrackets.match(/^(.+?)\s+(?:"[^"]*"|'[^']*')$/);
  return titleMatch ? titleMatch[1].trim() : withoutBrackets;
}

function inferMediaKind(rawTarget) {
  const target = String(rawTarget || "").trim().split(/[?#]/, 1)[0].toLowerCase();
  if (!target) {
    return null;
  }

  if (target.startsWith("data:image/")) {
    return "image";
  }
  if (target.startsWith("data:video/")) {
    return "video";
  }
  if (target.startsWith("data:audio/")) {
    return "audio";
  }

  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(target)) {
    return "image";
  }
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(target)) {
    return "video";
  }
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(target)) {
    return "audio";
  }

  return null;
}

function toFileUrl(filePath) {
  try {
    if (typeof window.require === "function") {
      const { pathToFileURL } = window.require("node:url");
      return pathToFileURL(filePath).href;
    }
  } catch {
    // Fall through to a best-effort file URL.
  }

  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) {
    return "";
  }

  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withLeadingSlash)}`;
}

function resolveMediaSource(rawTarget) {
  const target = stripMarkdownLinkTitle(rawTarget);
  if (!target) {
    return "";
  }

  if (/^(https?:|file:|blob:)/i.test(target)) {
    return target;
  }

  if (/^data:(image|video|audio)\//i.test(target)) {
    return target;
  }

  const looksAbsoluteWindowsPath = /^[a-z]:[\\/]/i.test(target);
  const looksAbsolutePosixPath = target.startsWith("/");
  if (looksAbsoluteWindowsPath || looksAbsolutePosixPath) {
    return toFileUrl(target);
  }

  if (state.cwd && (/^\.\.?(\/|\\)/.test(target) || /^[^:]+[\\/]/.test(target) || inferMediaKind(target))) {
    try {
      if (typeof window.require === "function") {
        const path = window.require("node:path");
        return toFileUrl(path.resolve(state.cwd, target));
      }
    } catch {
      // Fall back to the unresolved source.
    }
  }

  return target;
}

function parseMarkdownMediaBlock(line) {
  const match = String(line || "").match(/^\s*!\[([^\]]*)\]\((.+)\)\s*$/);
  if (!match) {
    return null;
  }

  const alt = match[1].trim();
  const target = stripMarkdownLinkTitle(match[2]);
  const kind = inferMediaKind(target);
  if (!kind) {
    return null;
  }

  const src = resolveMediaSource(target);
  if (!src) {
    return null;
  }

  return {
    kind,
    alt,
    src,
    rawTarget: target,
  };
}

function hasMarkdownMedia(text) {
  return /!\[[^\]]*\]\((.+)\)/.test(String(text || ""));
}

function renderMarkdownMedia(media) {
  const alt = escapeHtmlAttribute(media.alt || "");
  const src = escapeHtmlAttribute(media.src || "");
  const caption = media.alt ? `<figcaption>${escapeHtml(media.alt)}</figcaption>` : "";

  if (media.kind === "image") {
    return `<figure class="markdown-media is-image"><img src="${src}" alt="${alt}" loading="lazy" />${caption}</figure>`;
  }

  if (media.kind === "video") {
    return `<figure class="markdown-media is-video"><video controls preload="metadata" playsinline src="${src}"></video>${caption}</figure>`;
  }

  if (media.kind === "audio") {
    return `<figure class="markdown-media is-audio"><audio controls preload="metadata" src="${src}"></audio>${caption}</figure>`;
  }

  return "";
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) {
    return [];
  }

  let row = trimmed;
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|")) {
    row = row.slice(0, -1);
  }

  return row.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function getMarkdownTableAlignment(cell) {
  const trimmed = String(cell || "").trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
    return "center";
  }
  if (trimmed.endsWith(":")) {
    return "right";
  }
  if (trimmed.startsWith(":")) {
    return "left";
  }
  return "";
}

function renderMarkdownTable(headerLine, dividerLine, rowLines) {
  const headers = splitMarkdownTableRow(headerLine);
  const alignments = splitMarkdownTableRow(dividerLine).map((cell) => getMarkdownTableAlignment(cell));
  const bodyRows = rowLines.map((line) => {
    const cells = splitMarkdownTableRow(line);
    while (cells.length < headers.length) {
      cells.push("");
    }
    return cells.slice(0, headers.length);
  });

  const headHtml = headers
    .map((cell, index) => {
      const alignment = alignments[index] ? ` style="text-align:${alignments[index]}"` : "";
      return `<th${alignment}>${renderInlineMarkdown(cell)}</th>`;
    })
    .join("");

  const bodyHtml = bodyRows
    .map((row) => {
      const cells = row
        .map((cell, index) => {
          const alignment = alignments[index] ? ` style="text-align:${alignments[index]}"` : "";
          return `<td${alignment}>${renderInlineMarkdown(cell)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<div class="markdown-table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
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

    const mediaBlock = parseMarkdownMediaBlock(line);
    if (mediaBlock) {
      flushParagraph();
      flushList();
      html.push(renderMarkdownMedia(mediaBlock));
      continue;
    }

    const nextLine = lines[index + 1];
    if (line.includes("|") && nextLine && isMarkdownTableDivider(nextLine)) {
      const headerCells = splitMarkdownTableRow(line);
      const dividerCells = splitMarkdownTableRow(nextLine);
      if (headerCells.length > 1 && dividerCells.length === headerCells.length) {
        flushParagraph();
        flushList();

        const rowLines = [];
        let rowIndex = index + 2;
        while (rowIndex < lines.length) {
          const rowLine = lines[rowIndex];
          if (!rowLine.trim() || !rowLine.includes("|")) {
            break;
          }
          rowLines.push(rowLine);
          rowIndex += 1;
        }

        html.push(renderMarkdownTable(line, nextLine, rowLines));
        index = rowIndex - 1;
        continue;
      }
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
  if (role === "assistant" || role === "system" || role === "user") {
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
  header.tabIndex = 0;
  header.setAttribute("role", "button");
  header.setAttribute("aria-pressed", "false");
  header.addEventListener("click", () => {
    setActiveInspectorThread(threadId);
  });
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    setActiveInspectorThread(threadId);
  });

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
    header,
    body,
    titleElement,
    metaElement,
    statusElement,
  };

  state.threadContexts.set(threadId, context);
  setActiveInspectorThread(threadId);
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

  if (state.activeInspectorThreadId === threadId) {
    renderInspectorContext();
    renderWorkingSet();
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
    completed: false,
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
    assistantState.completed = false;
    return;
  }

  assistantState.bubble = createBubble("assistant", text, threadId);
  assistantState.renderedText = String(text);
  assistantState.visibleText = String(text);
  assistantState.turnText = "";
  assistantState.completed = false;
}

function sealAssistantSegment(threadId) {
  const assistantState = state.assistantStates.get(threadId);
  if (!assistantState) {
    return;
  }

  const hasVisibleText =
    String(assistantState.visibleText || "").trim() ||
    String(assistantState.turnText || "").trim() ||
    String(assistantState.renderedText || "").trim();

  if (!hasVisibleText && assistantState.bubble) {
    assistantState.bubble.wrapper.remove();
  }

  assistantState.bubble = null;
  assistantState.renderedText = "";
  assistantState.visibleText = "";
  assistantState.turnText = "";
  assistantState.completed = false;
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

function createTimelineEntryElement(threadId, entry) {
  const card = document.createElement("article");
  card.className = "panel-entry";
  decorateTimelineEntry(card, entry.category);
  card.dataset.entryId = entry.id;
  const isUtilityEntry = (entry.category === "tools" || entry.category === "commands") && !entry.approval;

  if (entry.compact) {
    card.classList.add("timeline-entry-compact");
  }
  if (isUtilityEntry) {
    card.classList.add("timeline-entry-utility");
  }
  if (entry.approval) {
    card.classList.add("timeline-entry-approval", "timeline-entry-elevated");
    if (entry.approvalKind) {
      card.classList.add(`timeline-entry-approval-${entry.approvalKind}`);
    }
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
    if (entry.markdown === true || hasMarkdownMedia(entry.summary)) {
      summary.innerHTML = renderMarkdown(entry.summary);
    } else {
      summary.textContent = entry.summary;
    }
    card.append(summary);
  }

  if (Array.isArray(entry.badges) && entry.badges.length > 0) {
    const badges = document.createElement("div");
    badges.className = "panel-entry-badges";

    for (const badge of entry.badges) {
      const chip = document.createElement("span");
      chip.className = "panel-entry-badge";
      if (badge.tone) {
        chip.classList.add(`is-${badge.tone}`);
      }
      chip.textContent = badge.label;
      badges.append(chip);
    }

    card.append(badges);
  }

  const inlineRow = isUtilityEntry ? document.createElement("div") : null;
  if (inlineRow) {
    inlineRow.className = "timeline-entry-inline-row";
  }

  if (Array.isArray(entry.files) && entry.files.length > 0) {
    const files = document.createElement("div");
    files.className = "panel-entry-files";

    for (const filePath of entry.files) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "panel-entry-file-chip";
      chip.textContent = filePath;
      chip.title = filePath;
      chip.addEventListener("click", async () => {
        await handleEntryFileChipClick(threadId, entry, filePath);
      });
      files.append(chip);
    }

    if (inlineRow) {
      inlineRow.append(files);
    } else {
      card.append(files);
    }
  }

  if (entry.detail) {
    const disclosure = buildDisclosure("Raw output", "panel-entry-detail", entry.detail, entry.status === "failed");
    if (inlineRow) {
      inlineRow.append(disclosure);
    } else {
      card.append(disclosure);
    }
  }

  if (entry.diff) {
    const disclosure = buildDisclosure("Diff preview", "panel-entry-diff", entry.diff);
    if (inlineRow) {
      inlineRow.append(disclosure);
    } else {
      card.append(disclosure);
    }
  }

  if (entry.requestText) {
    const disclosure = buildDisclosure("Request details", "panel-entry-detail", entry.requestText, true);
    if (inlineRow) {
      inlineRow.append(disclosure);
    } else {
      card.append(disclosure);
    }
  }

  if (entry.diff) {
    const actions = document.createElement("div");
    actions.className = "timeline-entry-actions";

    const inspectDiffButton = document.createElement("button");
    inspectDiffButton.type = "button";
    inspectDiffButton.className = "ghost-button";
    inspectDiffButton.textContent = "Inspect Diff";
    inspectDiffButton.addEventListener("click", () => {
      setInspectorCollapsed(false);
      setActiveDiff(createDiffSelection(threadId, entry, entry.files?.[0] || null));
    });

    actions.append(inspectDiffButton);
    if (inlineRow) {
      inlineRow.append(actions);
    } else {
      card.append(actions);
    }
  }

  if (inlineRow?.childNodes.length) {
    card.append(inlineRow);
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
  const element = createTimelineEntryElement(threadId, entry);
  context.body.append(element);
  state.activityEntryMap.set(activityEntryKey(threadId, entry.id), { entry, element });
  rebalanceThreadBatches(threadId);
  rebuildThreadTouchedFiles(threadId);
  if (!state.activeInspectorThreadId || state.activeInspectorThreadId === threadId) {
    setActiveInspectorThread(threadId);
  }
  if (entry.diff && (!state.activeDiff || (state.running && state.activeInspectorThreadId === threadId))) {
    setActiveDiff(createDiffSelection(threadId, entry, entry.files?.[0] || null));
  } else {
    renderWorkingSet();
    renderInspectorContext();
  }
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
  const nextElement = createTimelineEntryElement(threadId, merged);
  existing.element.replaceWith(nextElement);
  state.activityEntryMap.set(key, { entry: merged, element: nextElement });
  rebalanceThreadBatches(threadId);
  rebuildThreadTouchedFiles(threadId);
  if (!state.activeInspectorThreadId || state.activeInspectorThreadId === threadId) {
    setActiveInspectorThread(threadId);
  }
  if (merged.diff && (!state.activeDiff || state.activeDiff.entryId === merged.id || (state.running && state.activeInspectorThreadId === threadId))) {
    setActiveDiff(createDiffSelection(threadId, merged, merged.files?.[0] || null));
  } else {
    renderWorkingSet();
    renderInspectorContext();
  }
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
  assistantState.completed = false;
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

function toolBatchFamily(toolName) {
  return TIMELINE_BATCH_FAMILIES.get(String(toolName || "").trim()) || null;
}

function isBatchableTimelineEntry(entry) {
  if (!entry || entry.category !== "tools") {
    return null;
  }

  if (entry.approval || entry.diff) {
    return null;
  }

  if (entry.status === "failed" || entry.status === "error" || entry.status === "pending" || entry.status === "running") {
    return null;
  }

  return entry.batchFamily || toolBatchFamily(entry.toolName || entry.title);
}

function getTimelineEntryRecord(threadId, entryId) {
  return state.activityEntryMap.get(activityEntryKey(threadId, entryId)) || null;
}

function getTimelineEntryRecordFromElement(threadId, element) {
  const entryId = element?.dataset?.entryId;
  if (!entryId) {
    return null;
  }
  return getTimelineEntryRecord(threadId, entryId);
}

function describeTimelineBatch(entries) {
  const family = isBatchableTimelineEntry(entries[0]) || "inspection";
  const stepCount = entries.length;
  const files = uniqueWorkspacePaths(entries.flatMap((entry) => (Array.isArray(entry.files) ? entry.files : [])));
  const lastMeta = entries[entries.length - 1]?.meta || "";
  const allInformational = entries.every((entry) => entry.status === "info");

  switch (family) {
    case "file-read":
      return {
        family,
        title: files.length > 0 ? `Read ${pluralize(files.length, "file")}` : `Read files in ${pluralize(stepCount, "step")}`,
        summary: `Grouped ${pluralize(stepCount, "read-only inspection step")} to keep the timeline focused. Expand to inspect each result.`,
        files,
        meta: [pluralize(stepCount, "tool step"), lastMeta].filter(Boolean).join(" · "),
        status: allInformational ? "info" : "completed",
        statusLabel: pluralize(stepCount, "step"),
      };
    case "symbol-inspection":
      return {
        family,
        title: `Inspected symbols in ${pluralize(stepCount, "step")}`,
        summary: "Grouped symbol lookups and reference checks. Expand to inspect each result.",
        files,
        meta: [pluralize(stepCount, "tool step"), lastMeta].filter(Boolean).join(" · "),
        status: allInformational ? "info" : "completed",
        statusLabel: pluralize(stepCount, "step"),
      };
    case "text-search":
      return {
        family,
        title: `Ran ${pluralize(stepCount, "search")}`,
        summary: "Grouped repeated text searches. Expand to inspect each query and result.",
        files,
        meta: [pluralize(stepCount, "tool step"), lastMeta].filter(Boolean).join(" · "),
        status: allInformational ? "info" : "completed",
        statusLabel: pluralize(stepCount, "step"),
      };
    case "workspace-scan":
      return {
        family,
        title: `Scanned workspace in ${pluralize(stepCount, "step")}`,
        summary: "Grouped repeated workspace inspection steps. Expand to inspect each result.",
        files,
        meta: [pluralize(stepCount, "tool step"), lastMeta].filter(Boolean).join(" · "),
        status: allInformational ? "info" : "completed",
        statusLabel: pluralize(stepCount, "step"),
      };
    default:
      return {
        family,
        title: `Grouped ${pluralize(stepCount, "tool step")}`,
        summary: "Grouped repetitive tool activity. Expand to inspect each result.",
        files,
        meta: [pluralize(stepCount, "tool step"), lastMeta].filter(Boolean).join(" · "),
        status: allInformational ? "info" : "completed",
        statusLabel: pluralize(stepCount, "step"),
      };
  }
}

function createTimelineBatchElement(threadId, batchId, records) {
  const entries = records.map((record) => record.entry);
  const batch = describeTimelineBatch(entries);

  const wrapper = document.createElement("details");
  wrapper.className = "panel-entry timeline-batch";
  decorateTimelineEntry(wrapper, "tools");
  wrapper.dataset.batchId = batchId;
  wrapper.dataset.batchFamily = batch.family;
  wrapper.open = state.timelineBatchOpen.has(batchId);

  const summary = document.createElement("summary");
  summary.className = "timeline-batch-summary";

  const label = document.createElement("div");
  label.className = "panel-entry-label";
  label.textContent = "Tool Batch";
  summary.append(label);

  const header = document.createElement("div");
  header.className = "panel-entry-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "panel-entry-title";

  const title = document.createElement("strong");
  title.textContent = batch.title;

  const meta = document.createElement("div");
  meta.className = "panel-entry-meta";
  meta.textContent = batch.meta;

  titleWrap.append(title, meta);
  header.append(titleWrap);

  const status = document.createElement("div");
  status.className = "panel-entry-status";
  const tone = pickEntryTone(batch.status);
  if (tone) {
    status.classList.add(tone);
  }
  status.textContent = batch.statusLabel;
  header.append(status);
  summary.append(header);

  const summaryText = document.createElement("div");
  summaryText.className = "timeline-batch-text";
  summaryText.textContent = batch.summary;
  summary.append(summaryText);

  if (batch.files.length > 0) {
    const files = document.createElement("div");
    files.className = "panel-entry-files timeline-batch-files";

    for (const filePath of batch.files.slice(0, 6)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "panel-entry-file-chip";
      chip.textContent = filePath;
      chip.title = filePath;
      chip.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        setActiveInspectorThread(threadId);
        setInspectorCollapsed(false);
        await previewWorkspaceFile(filePath);
      });
      files.append(chip);
    }

    if (batch.files.length > 6) {
      const more = document.createElement("div");
      more.className = "timeline-batch-more";
      more.textContent = `+${batch.files.length - 6} more`;
      files.append(more);
    }

    summary.append(files);
  }

  const caption = document.createElement("div");
  caption.className = "timeline-batch-caption";
  const updateCaption = () => {
    caption.textContent = wrapper.open
      ? `Collapse ${pluralize(records.length, "step")}`
      : `Expand ${pluralize(records.length, "step")} to inspect each result`;
  };
  updateCaption();
  summary.append(caption);

  const content = document.createElement("div");
  content.className = "timeline-batch-entries";

  wrapper.addEventListener("toggle", () => {
    if (wrapper.open) {
      state.timelineBatchOpen.add(batchId);
    } else {
      state.timelineBatchOpen.delete(batchId);
    }
    updateCaption();
  });

  wrapper.append(summary, content);
  return { wrapper, content };
}

function unwrapThreadBatches(body) {
  const wrappers = [...body.children].filter((child) => child.classList?.contains("timeline-batch"));
  for (const wrapper of wrappers) {
    const content = wrapper.querySelector(".timeline-batch-entries");
    const children = content ? [...content.children] : [];
    for (const child of children) {
      child.classList.remove("timeline-batch-child");
      body.insertBefore(child, wrapper);
    }
    wrapper.remove();
  }
}

function rebalanceThreadBatches(threadId) {
  const context = state.threadContexts.get(threadId);
  if (!context) {
    return;
  }

  const body = context.body;
  unwrapThreadBatches(body);

  const children = [...body.children];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const record = getTimelineEntryRecordFromElement(threadId, child);
    const family = record ? isBatchableTimelineEntry(record.entry) : null;
    if (!family) {
      continue;
    }

    const records = [record];
    const elementsToMove = [child];
    let cursor = index + 1;

    while (cursor < children.length) {
      const nextChild = children[cursor];
      const nextRecord = getTimelineEntryRecordFromElement(threadId, nextChild);
      const nextFamily = nextRecord ? isBatchableTimelineEntry(nextRecord.entry) : null;
      if (nextFamily !== family) {
        break;
      }
      records.push(nextRecord);
      elementsToMove.push(nextChild);
      cursor += 1;
    }

    if (records.length >= TIMELINE_BATCH_MIN_SIZE) {
      const batchId = `${threadId}:${family}:${records[0].entry.id}`;
      const { wrapper, content } = createTimelineBatchElement(threadId, batchId, records);
      body.insertBefore(wrapper, elementsToMove[0]);
      for (const element of elementsToMove) {
        element.classList.add("timeline-batch-child");
        content.append(element);
      }
    }

    index = cursor - 1;
  }
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
    toolName: toolCall.name,
    batchFamily: toolBatchFamily(toolCall.name),
    category: COMMAND_TOOL_NAMES.has(toolCall.name) ? "commands" : "tools",
    label: COMMAND_TOOL_NAMES.has(toolCall.name) ? "Command" : "Tool",
    title: toolCall.name,
    meta: `Started ${formatTime(new Date().toISOString())}`,
    status: "pending",
    statusLabel: "Pending",
    summary: summarizePendingTool(toolCall.name, toolCall.arguments || {}),
    detail: "",
    diff: "",
    compact: true,
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
  const diffInfo = parseUnifiedDiff(diff);
  const files = collectToolResultFiles(toolCall, result, diffInfo);

  return {
    id: toolCall.callId,
    toolName: toolCall.name,
    batchFamily: toolBatchFamily(toolCall.name),
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
    diffInfo,
    files,
    compact: true,
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

function inferApprovalKind(approval, diffInfo) {
  if (typeof approval?.approvalKind === "string" && approval.approvalKind) {
    return approval.approvalKind;
  }
  if (COMMAND_TOOL_NAMES.has(approval?.toolName)) {
    return "command";
  }
  if (diffInfo?.changedPaths?.length) {
    return "write";
  }
  if (NETWORK_APPROVAL_TOOL_NAMES.has(approval?.toolName)) {
    return "network";
  }
  return "generic";
}

function inferApprovalRiskLevel(approval, approvalKind, requestText, files) {
  if (typeof approval?.riskLevel === "string" && approval.riskLevel) {
    return approval.riskLevel;
  }

  if (approvalKind === "command") {
    if (HIGH_RISK_COMMAND_PATTERN.test(requestText)) {
      return "high";
    }
    if (MEDIUM_RISK_COMMAND_PATTERN.test(requestText)) {
      return "medium";
    }
    return "medium";
  }

  if (approvalKind === "write") {
    if (files.length >= 5 || files.some((filePath) => SENSITIVE_WRITE_PATH_PATTERN.test(filePath))) {
      return "high";
    }
    if (files.length >= 2) {
      return "medium";
    }
    return "low";
  }

  if (approvalKind === "network") {
    return requestText.startsWith("fetch url:") ? "medium" : "low";
  }

  return "medium";
}

function approvalKindLabel(approvalKind) {
  if (approvalKind === "write") {
    return "File Write";
  }
  if (approvalKind === "command") {
    return "Shell Command";
  }
  if (approvalKind === "network") {
    return "External Request";
  }
  return "Sensitive Action";
}

function approvalEntryLabel(approvalKind) {
  if (approvalKind === "write") {
    return "Write Approval";
  }
  if (approvalKind === "command") {
    return "Command Approval";
  }
  if (approvalKind === "network") {
    return "Network Approval";
  }
  return "Approval";
}

function approvalRiskTone(riskLevel) {
  if (riskLevel === "high") {
    return "error";
  }
  if (riskLevel === "medium") {
    return "warning";
  }
  if (riskLevel === "low") {
    return "success";
  }
  return "neutral";
}

function buildApprovalBadges({ approvalKind, riskLevel, files, resolution }) {
  const badges = [
    {
      label: approvalKindLabel(approvalKind),
      tone: approvalKind === "write" ? "info" : approvalKind === "command" ? "warning" : "neutral",
    },
    {
      label: `${String(riskLevel || "medium").replace(/^./, (char) => char.toUpperCase())} Risk`,
      tone: approvalRiskTone(riskLevel),
    },
  ];

  if (approvalKind === "write" && files.length > 0) {
    badges.push({
      label: pluralize(files.length, "File"),
      tone: "neutral",
    });
  }

  if (approvalKind === "write" && !elements.previewWritesToggle.checked) {
    badges.push({
      label: "Diff Previews Off",
      tone: "neutral",
    });
  }

  if (resolution === "approved-similar") {
    badges.push({
      label: "Similar This Run",
      tone: "success",
    });
  }

  if (resolution === "auto-approved") {
    badges.push({
      label: "Auto-approved",
      tone: "success",
    });
  }

  return badges;
}

function enablePreviewWritesFromApproval() {
  if (elements.previewWritesToggle.checked) {
    return;
  }

  elements.previewWritesToggle.checked = true;
  syncTopbarState();
  setStatus("Preview writes is now enabled for future runs. Save Defaults if you want to keep it for this workspace.");
  for (const approval of state.approvals) {
    upsertTimelineEntry(approval.threadId, createApprovalTimelineEntry(approval));
  }
}

async function respondToApproval(approval, decision = "approve-once") {
  const approved = decision !== "deny";
  appendDebug(`approval:click ${decision} requestId=${approval.requestId}`);
  if (!desktopApi) {
    setStatus("Desktop IPC bridge is unavailable.");
    appendDebug("approval:error desktopApi missing");
    return;
  }

  await desktopApi.respondApproval(approval.requestId, { decision });
  state.approvals = state.approvals.filter((item) => item.requestId !== approval.requestId);
  upsertTimelineEntry(
    approval.threadId,
    createApprovalTimelineEntry(
      approval,
      approved ? (decision === "approve-similar-run" ? "approved-similar" : "approved") : "denied",
    ),
  );
  updateProgress({
    phase: approved ? "running-tools" : "tool-error",
    activeToolName: approval.toolName,
  });
  if (!approved) {
    setStatus(`Denied ${approval.toolName}. Waiting for the run to react...`);
    return;
  }

  if (decision === "approve-similar-run") {
    setStatus(`Approved ${approval.toolName}. Similar requests in this run will continue automatically.`);
    return;
  }

  setStatus(`Approved ${approval.toolName}. Waiting for the run to continue...`);
}

function createApprovalTimelineEntry(approval, resolution = "pending") {
  const { requestText, diffText } = splitApprovalSummary(approval.summary);
  const diffInfo = parseUnifiedDiff(diffText);
  const files = collectApprovalFiles(approval, diffInfo);
  const approvalKind = inferApprovalKind(approval, diffInfo);
  const riskLevel = inferApprovalRiskLevel(approval, approvalKind, requestText, files);
  const status = resolution === "denied" ? "failed" : resolution === "pending" ? "pending" : "completed";
  const statusLabel =
    resolution === "approved"
      ? "Approved Once"
      : resolution === "approved-similar"
        ? "Approved for Similar Requests"
        : resolution === "auto-approved"
          ? "Auto-approved"
          : resolution === "denied"
            ? "Denied"
            : "Needs Review";
  const pendingSummary = requestText
    ? truncateText(requestText, 240)
    : `Review the ${approval.toolName} request before the run continues.`;
  const resolutionSummary =
    resolution === "approved"
      ? `${approvalKindLabel(approvalKind)} approved once. The run can continue.`
      : resolution === "approved-similar"
        ? `${approvalKindLabel(approvalKind)} approved. Similar requests in this run will continue automatically.`
        : resolution === "auto-approved"
          ? `${approvalKindLabel(approvalKind)} matched an earlier approval in this run, so it continued automatically.`
          : `${approvalKindLabel(approvalKind)} was denied.`;

  return {
    id: approval.requestId,
    category: approvalKind === "command" ? "commands" : "tools",
    label: approvalEntryLabel(approvalKind),
    title: approval.toolName,
    meta:
      resolution === "pending"
        ? `${approvalKindLabel(approvalKind)} · Action paused until you decide`
        : `${approvalKindLabel(approvalKind)} · Decision recorded ${formatTime(new Date().toISOString())}`,
    status,
    statusLabel,
    summary: resolution === "pending" ? pendingSummary : resolutionSummary,
    requestText,
    diff: diffText,
    diffInfo,
    files,
    approval: true,
    approvalKind,
    badges: buildApprovalBadges({
      approvalKind,
      riskLevel,
      files,
      resolution,
    }),
    renderActions: resolution !== "pending"
      ? null
      : () => {
          const actions = document.createElement("div");
          actions.className = "timeline-entry-actions";
          const actionNodes = [];

          const approveButton = document.createElement("button");
          approveButton.className = "solid-button";
          approveButton.textContent = "Approve Once";
          approveButton.addEventListener("click", async () => {
            await respondToApproval(approval, "approve-once");
          });
          actionNodes.push(approveButton);

          const approveSimilarButton = document.createElement("button");
          approveSimilarButton.className = "ghost-button";
          approveSimilarButton.textContent = "Approve Similar This Run";
          approveSimilarButton.addEventListener("click", async () => {
            await respondToApproval(approval, "approve-similar-run");
          });
          actionNodes.push(approveSimilarButton);

          if (approvalKind === "write" && !elements.previewWritesToggle.checked) {
            const previewWritesButton = document.createElement("button");
            previewWritesButton.className = "ghost-button";
            previewWritesButton.textContent = "Always Preview Writes";
            previewWritesButton.addEventListener("click", () => {
              enablePreviewWritesFromApproval();
            });
            actionNodes.push(previewWritesButton);
          }

          const denyButton = document.createElement("button");
          denyButton.className = "ghost-button";
          denyButton.textContent = "Deny";
          denyButton.addEventListener("click", async () => {
            await respondToApproval(approval, "deny");
          });
          actionNodes.push(denyButton);

          actions.append(...actionNodes);
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
    const isActive = state.currentSessionId === session.id;
    const isBranchSource = state.branchSessionId === session.id;
    card.className = `session-item ${isActive ? "active" : ""} ${isBranchSource ? "branch-source" : ""}`;

    const header = document.createElement("div");
    header.className = "session-item-header";

    const actions = document.createElement("div");
    actions.className = "session-item-actions";

    const branchButton = document.createElement("button");
    branchButton.type = "button";
    branchButton.className = `session-branch-button ${isBranchSource ? "is-active" : ""}`;
    branchButton.textContent = isBranchSource ? "Branching" : "Branch";
    branchButton.disabled = state.running;
    branchButton.title = state.running
      ? "Wait for the current run to finish before branching sessions."
      : "Start the next run from this session but save it as a new branch.";
    branchButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await branchSessionFromUi(session);
    });

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

    actions.append(branchButton, deleteButton);
    header.append(actions);

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-open-button";
    const title = document.createElement("strong");
    const sessionTitle = session.lastUserPrompt || "Untitled session";
    title.textContent = sessionTitle;
    title.title = sessionTitle;
    openButton.title = `${sessionTitle}\n${session.cwd}`;
    const workspace = document.createElement("span");
    workspace.className = "session-workspace-path";
    workspace.textContent = formatWorkspaceLabel(session.cwd);
    workspace.title = session.cwd;
    const model = document.createElement("span");
    model.textContent = session.model;
    const updated = document.createElement("span");
    updated.textContent = formatTime(session.updatedAt);
    const branchStatus = document.createElement("span");
    if (isBranchSource) {
      branchStatus.className = "session-branch-badge";
      branchStatus.textContent = "Branch source for the next run";
    }
    openButton.append(title, workspace, model, updated);
    if (isBranchSource) {
      openButton.append(branchStatus);
    }
    openButton.addEventListener("click", async () => {
      await openSessionFromUi(session);
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

  const payload = await desktopApi.deleteSession(session.cwd || state.cwd, session.id);
  state.sessions = payload?.sessions || [];

  if (!payload?.deleted) {
    renderSessions();
    setStatus("Could not delete that session.");
    return;
  }

  if (state.currentSessionId === session.id) {
    state.currentSessionId = null;
    state.branchSessionId = null;
    resetTranscriptView();
    resetProgress();
  }

  if (state.branchSessionId === session.id) {
    state.branchSessionId = null;
  }

  renderSessions();
  setStatus(`Deleted session: ${truncateText(title, 80)}`);
}

async function branchSessionFromUi(session) {
  if (state.running) {
    setStatus("Wait for the current run to finish before branching sessions.");
    return;
  }

  const loaded = await openSessionFromUi(session, {
    branch: true,
    suppressStatus: true,
  });
  if (!loaded) {
    setStatus("Could not load that session to branch.");
    return;
  }

  setStatus(`Branching from "${truncateText(session.lastUserPrompt || "Untitled session", 64)}". The next run will be saved as a new session.`);
}

async function openHistoryFolderFromUi() {
  if (!desktopApi) {
    setStatus("Desktop IPC bridge is unavailable.");
    return;
  }

  const result = await desktopApi.openHistoryFolder(state.cwd);
  if (!result?.ok) {
    setStatus(result?.error || "Could not open the history folder.");
    return;
  }

  setStatus(`Opened history folder for ${formatWorkspaceLabel(state.cwd)}.`);
}

async function clearWorkspaceHistoryFromUi() {
  if (state.running) {
    setStatus("Wait for the current run to finish before clearing workspace history.");
    return;
  }

  if (!desktopApi) {
    setStatus("Desktop IPC bridge is unavailable.");
    return;
  }

  const confirmed = window.confirm(
    `Clear saved history for this workspace?\n\nThis removes stored sessions, transcripts, and command logs under ${state.cwd}/.gradient-code, but keeps project notes.`,
  );
  if (!confirmed) {
    return;
  }

  const payload = await desktopApi.clearWorkspaceHistory(state.cwd);
  state.sessions = payload?.sessions || [];
  state.currentSessionId = null;
  state.branchSessionId = null;
  resetTranscriptView();
  ensureWorkspaceThread();
  resetProgress();
  renderSessions();
  setStatus(payload?.cleared ? "Workspace history cleared." : "No workspace history was found to clear.");
}

function startNewSessionFromUi() {
  if (state.running) {
    setStatus("Wait for the current run to finish before starting a new session.");
    return;
  }

  state.currentSessionId = null;
  state.branchSessionId = null;
  state.approvals = [];
  resetTranscriptView();
  ensureWorkspaceThread();
  resetProgress();
  renderSessions();
  setStatus(`New session ready in ${formatWorkspaceLabel(state.cwd)}. Your next message will start fresh.`);
  elements.promptInput.focus();
}

function populateModelSelect(selectElement, options, selectedModel) {
  selectElement.textContent = "";
  const nextOptions = Array.isArray(options) ? options : [];

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

    selectElement.append(group);
  }

  const fallbackModel = nextOptions[0]?.id || "kimi-k2.5";
  const selectedValue = nextOptions.some((option) => option.id === selectedModel) ? selectedModel : fallbackModel;
  selectElement.value = selectedValue;
  return selectedValue;
}

function populateModelOptions(options, selectedModel) {
  const nextOptions = Array.isArray(options) ? options : [];
  const selectedValue = populateModelSelect(elements.modelInput, nextOptions, selectedModel);
  populateModelSelect(elements.collapsedModelInput, nextOptions, selectedValue);
  state.model = selectedValue;
}

function applyConfigToUi(cwd, config, sessions, modelOptions, projectNotes) {
  const previousCwd = state.cwd;
  state.cwd = cwd;
  state.modelOptions = Array.isArray(modelOptions) ? modelOptions : state.modelOptions;
  state.sessions = sessions || [];

  if (previousCwd !== state.cwd) {
    invalidateCommandPaletteFileIndex();
  }

  elements.workspaceInput.value = state.cwd;
  elements.maxTurnsInput.value = String(config.maxTurns || 12);
  elements.approveAllToggle.checked = Boolean(config.approveAll);
  elements.previewWritesToggle.checked = config.previewEdits !== false;
  elements.storeHistoryToggle.checked = config.storeResponses !== false;
  populateModelOptions(state.modelOptions, config.model || state.model || "kimi-k2.5");
  setPreset(config.preset || state.preset || "default");
  syncTopbarState();
  applyProjectNotesPayload(projectNotes);

  renderSessions();
}

function resetTranscriptView() {
  elements.transcript.textContent = "";
  state.threadContexts = new Map();
  state.assistantStates = new Map();
  state.runThreadMap = new Map();
  state.activityEntryMap = new Map();
  state.timelineBatchOpen = new Set();
  state.threadTouchedFiles = new Map();
  state.workspaceThreadId = null;
  state.pendingThreadId = null;
  state.currentRunId = null;
  state.activeInspectorThreadId = null;
  state.activeDiff = null;
  state.activeDiffFilePath = null;
  state.nextThreadIndex = 1;
  renderWorkingSet();
  renderInspectorContext();
  renderDiffInspector();
}

function renderSessionTranscript(events) {
  resetTranscriptView();

  let currentThreadId = null;
  let currentRunId = null;
  let threadIndex = 0;
  const callInputs = new Map();

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
      callInputs.set(event.callId, event.input || {});
      sealAssistantSegment(currentThreadId);
      upsertTimelineEntry(currentThreadId, createPendingToolEntry({
        toolCall: {
          callId: event.callId,
          name: event.toolName,
          arguments: event.input || {},
        },
      }));
      continue;
    }

    if (event.type === "tool_result") {
      sealAssistantSegment(currentThreadId);
      upsertTimelineEntry(currentThreadId, createFinishedToolEntry({
        toolCall: {
          callId: event.callId,
          name: event.toolName,
          arguments: callInputs.get(event.callId) || {},
        },
        result: event.result,
      }));
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
    applyConfigToUi(payload.cwd, payload.config, payload.sessions, payload.modelOptions, payload.projectNotes);
    if (state.workspaceThreadId) {
      updateThreadContext(state.workspaceThreadId, {
        subtitle: formatWorkspaceLabel(payload.cwd),
      });
    }
    await reloadWorkspaceBrowser();
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
    applyConfigToUi(payload.cwd, payload.config, payload.sessions, payload.modelOptions, payload.projectNotes);
    state.currentSessionId = null;
    state.branchSessionId = null;
    resetTranscriptView();
    ensureWorkspaceThread();
    await reloadWorkspaceBrowser();
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
    storeResponses: elements.storeHistoryToggle.checked,
    maxTurns: Number.parseInt(elements.maxTurnsInput.value || "12", 10),
    preset: state.preset,
    includeProjectNotes: state.projectNotesIncludeInPrompt,
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
  const branchSessionId = resumeLast ? null : state.branchSessionId;
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
      store: elements.storeHistoryToggle.checked,
      maxTurns: Number.parseInt(elements.maxTurnsInput.value || "12", 10),
      sessionId: resumeLast ? null : state.currentSessionId,
      branchSessionId,
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
      if (assistantState.completed) {
        sealAssistantSegment(threadId);
      }
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
      assistantState.completed = true;
      return;
    }

    if (payload.type === "tool-call") {
      const threadId = state.runThreadMap.get(payload.runId) ?? state.pendingThreadId;
      if (threadId) {
        sealAssistantSegment(threadId);
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
        sealAssistantSegment(threadId);
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
      sealAssistantSegment(threadId);
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

    if (payload.type === "approval-auto-resolved") {
      const threadId =
        (payload.runId ? state.runThreadMap.get(payload.runId) : null) ??
        (state.currentRunId ? state.runThreadMap.get(state.currentRunId) : null) ??
        state.pendingThreadId ??
        ensureWorkspaceThread();
      sealAssistantSegment(threadId);
      const approval = {
        ...payload,
        threadId,
      };
      upsertTimelineEntry(threadId, createApprovalTimelineEntry(approval, "auto-approved"));
      updateProgress({
        phase: "running-tools",
        activeToolName: payload.toolName,
      });
      setStatus(`Auto-approved ${payload.toolName} based on an earlier decision in this run.`);
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
      state.branchSessionId = null;
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
        assistantState.completed = true;

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

elements.newSessionButton.addEventListener("click", () => {
  startNewSessionFromUi();
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

elements.inspectorToggleButton.addEventListener("click", () => {
  setInspectorCollapsed(!state.inspectorCollapsed);
});

elements.inspectorResizeHandle.addEventListener("mousedown", (event) => {
  startInspectorResize(event);
});

elements.inspectorResizeHandle.addEventListener("dblclick", () => {
  applyInspectorSplit(DEFAULT_INSPECTOR_SPLIT);
  saveInspectorSplitPreference();
});

elements.inspectorResizeHandle.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    nudgeInspectorSplit(-0.04);
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    nudgeInspectorSplit(0.04);
    return;
  }

  if (event.key === "Home") {
    event.preventDefault();
    applyInspectorSplit(inspectorSplitBounds().min);
    saveInspectorSplitPreference();
    return;
  }

  if (event.key === "End") {
    event.preventDefault();
    applyInspectorSplit(inspectorSplitBounds().max);
    saveInspectorSplitPreference();
  }
});

elements.topbarCollapseButton.addEventListener("click", () => {
  setTopbarCollapsed(true);
});

elements.topbarExpandButton.addEventListener("click", () => {
  setTopbarCollapsed(false);
});

elements.topbarQuickCloseButton.addEventListener("click", () => {
  state.topbarQuickEditor = null;
  syncTopbarState();
});

elements.refreshSessionsButton.addEventListener("click", async () => {
  await reloadWorkspaceState();
  setStatus("Workspace state refreshed.");
});

elements.openHistoryFolderButton.addEventListener("click", async () => {
  await openHistoryFolderFromUi();
});

elements.clearHistoryButton.addEventListener("click", async () => {
  await clearWorkspaceHistoryFromUi();
});

elements.reloadWorkspaceTreeButton.addEventListener("click", async () => {
  await reloadWorkspaceBrowser();
  setStatus("Workspace tree refreshed.");
});

elements.openSelectedFileButton.addEventListener("click", async () => {
  await openWorkspacePath(state.selectedBrowserPath);
});

elements.saveProjectNotesButton.addEventListener("click", async () => {
  await saveProjectNotesFromUi();
});

elements.openProjectNotesButton.addEventListener("click", async () => {
  await openProjectNotesFromUi();
});

elements.projectNotesIncludeToggle.addEventListener("change", () => {
  state.projectNotesIncludeInPrompt = elements.projectNotesIncludeToggle.checked;
  renderProjectNotes();
  renderInspectorContext();
});

elements.projectNotesInput.addEventListener("input", () => {
  state.projectNotesContent = elements.projectNotesInput.value;
  renderProjectNotes();
});

elements.projectNotesInput.addEventListener("keydown", async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    await saveProjectNotesFromUi();
  }
});

elements.diffUnifiedButton.addEventListener("click", () => {
  state.diffViewMode = "unified";
  renderDiffInspector();
});

elements.diffSplitButton.addEventListener("click", () => {
  state.diffViewMode = "split";
  renderDiffInspector();
});

elements.diffPreviewFileButton.addEventListener("click", async () => {
  if (!state.activeDiffFilePath) {
    return;
  }
  await previewWorkspaceFile(state.activeDiffFilePath);
  setInspectorTab("browser");
});

elements.diffOpenFileButton.addEventListener("click", async () => {
  if (!state.activeDiffFilePath) {
    return;
  }
  await openWorkspacePath(state.activeDiffFilePath);
});

elements.commandPaletteBackdrop.addEventListener("click", () => {
  closeCommandPalette();
});

elements.commandPaletteInput.addEventListener("input", () => {
  state.commandPaletteQuery = elements.commandPaletteInput.value;
  state.commandPaletteSelectedIndex = 0;
  renderCommandPalette();
  if (state.cwd && !state.commandPaletteLoading && state.commandPaletteWorkspacePath !== state.cwd) {
    void ensureCommandPaletteFileIndex();
  }
});

elements.commandPaletteInput.addEventListener("keydown", async (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveCommandPaletteSelection(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveCommandPaletteSelection(-1);
    return;
  }

  if (event.key === "Home") {
    event.preventDefault();
    state.commandPaletteSelectedIndex = 0;
    renderCommandPalette();
    return;
  }

  if (event.key === "End") {
    event.preventDefault();
    state.commandPaletteSelectedIndex = Math.max(0, state.commandPaletteResults.length - 1);
    renderCommandPalette();
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    await executeCommandPaletteItem();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
});

elements.saveConfigButton.addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (error) {
    setStatus(toErrorMessage(error));
  }
});

elements.workspaceInput.addEventListener("change", async () => {
  syncTopbarState();
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

elements.modelInput.addEventListener("change", () => {
  state.model = elements.modelInput.value || state.model;
  syncTopbarState();
});

elements.collapsedModelInput.addEventListener("change", () => {
  elements.modelInput.value = elements.collapsedModelInput.value;
  state.model = elements.collapsedModelInput.value || state.model;
  syncTopbarState();
});

elements.maxTurnsInput.addEventListener("input", () => {
  syncTopbarState();
});

elements.collapsedTurnsInput.addEventListener("input", () => {
  const nextValue = String(Math.max(1, Number.parseInt(elements.collapsedTurnsInput.value || "12", 10) || 12));
  elements.collapsedTurnsInput.value = nextValue;
  elements.maxTurnsInput.value = nextValue;
  syncTopbarState();
});

elements.approveAllToggle.addEventListener("change", () => {
  syncTopbarState();
});

elements.previewWritesToggle.addEventListener("change", () => {
  syncTopbarState();
});

elements.storeHistoryToggle.addEventListener("change", () => {
  syncTopbarState();
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
renderInspectorTabs();
renderWorkspaceTree();
renderFilePreview();
renderProjectNotes();
renderWorkingSet();
renderDiffInspector();
renderCommandPalette();
setPreset(state.preset);
syncTopbarState();
loadRunDetailsPreference();
loadTopbarPreference();
loadInspectorPreference();
loadInspectorSplitPreference();
appendDebug(`desktopApi:${desktopApi ? "available" : "missing"}`);
bootstrap();
window.addEventListener("resize", () => {
  fitAllSessionCards();
  applyInspectorSplit(state.inspectorSplitRatio);
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    toggleCommandPalette();
    return;
  }

  if (state.commandPaletteOpen && event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
});
