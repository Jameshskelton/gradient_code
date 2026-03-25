import { contextBridge, ipcRenderer } from "electron";
import type { GradientCodeConfig } from "@gradient-code/shared";

const desktopApi = {
  getBootstrap: (cwd?: string) => ipcRenderer.invoke("desktop:get-bootstrap", cwd),
  chooseWorkspace: (cwd?: string) => ipcRenderer.invoke("desktop:choose-workspace", cwd),
  listSessions: (cwd: string) => ipcRenderer.invoke("desktop:list-sessions", cwd),
  listWorkspaceTree: (cwd: string, relativePath?: string) =>
    ipcRenderer.invoke("desktop:list-workspace-tree", cwd, relativePath),
  readWorkspaceFile: (cwd: string, relativePath: string) =>
    ipcRenderer.invoke("desktop:read-workspace-file", cwd, relativePath),
  openWorkspacePath: (cwd: string, relativePath: string) =>
    ipcRenderer.invoke("desktop:open-workspace-path", cwd, relativePath),
  openHistoryFolder: (cwd: string) => ipcRenderer.invoke("desktop:open-history-folder", cwd),
  clearWorkspaceHistory: (cwd: string) => ipcRenderer.invoke("desktop:clear-workspace-history", cwd),
  loadSession: (cwd: string, sessionId: string) => ipcRenderer.invoke("desktop:load-session", cwd, sessionId),
  deleteSession: (cwd: string, sessionId: string) => ipcRenderer.invoke("desktop:delete-session", cwd, sessionId),
  saveConfig: (cwd: string, config: GradientCodeConfig) => ipcRenderer.invoke("desktop:save-config", cwd, config),
  startRun: (payload: Record<string, unknown>) => ipcRenderer.invoke("desktop:start-run", payload),
  cancelRun: () => ipcRenderer.invoke("desktop:cancel-run"),
  respondApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke("desktop:respond-approval", requestId, approved),
  onEvent: (callback: (payload: Record<string, unknown>) => void) => {
    const listener = (_event: unknown, payload: Record<string, unknown>) => callback(payload);
    ipcRenderer.on("desktop:event", listener);
    return () => {
      ipcRenderer.removeListener("desktop:event", listener);
    };
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("gradientCodeDesktop", desktopApi);
} else {
  // Electron loads the preload before renderer scripts, so this is safe when contexts are shared.
  (window as typeof window & { gradientCodeDesktop: typeof desktopApi }).gradientCodeDesktop = desktopApi;
}
