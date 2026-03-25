import { contextBridge, ipcRenderer } from "electron";
const desktopApi = {
    getBootstrap: (cwd) => ipcRenderer.invoke("desktop:get-bootstrap", cwd),
    chooseWorkspace: (cwd) => ipcRenderer.invoke("desktop:choose-workspace", cwd),
    listSessions: (cwd) => ipcRenderer.invoke("desktop:list-sessions", cwd),
    listWorkspaceTree: (cwd, relativePath) => ipcRenderer.invoke("desktop:list-workspace-tree", cwd, relativePath),
    readWorkspaceFile: (cwd, relativePath) => ipcRenderer.invoke("desktop:read-workspace-file", cwd, relativePath),
    openWorkspacePath: (cwd, relativePath) => ipcRenderer.invoke("desktop:open-workspace-path", cwd, relativePath),
    openHistoryFolder: (cwd) => ipcRenderer.invoke("desktop:open-history-folder", cwd),
    clearWorkspaceHistory: (cwd) => ipcRenderer.invoke("desktop:clear-workspace-history", cwd),
    saveProjectNotes: (cwd, payload) => ipcRenderer.invoke("desktop:save-project-notes", cwd, payload),
    openProjectNotes: (cwd) => ipcRenderer.invoke("desktop:open-project-notes", cwd),
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
if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("gradientCodeDesktop", desktopApi);
}
else {
    // Electron loads the preload before renderer scripts, so this is safe when contexts are shared.
    window.gradientCodeDesktop = desktopApi;
}
//# sourceMappingURL=preload.js.map