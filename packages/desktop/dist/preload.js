import { contextBridge, ipcRenderer } from "electron";
const desktopApi = {
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
if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("gradientCodeDesktop", desktopApi);
}
else {
    // Electron loads the preload before renderer scripts, so this is safe when contexts are shared.
    window.gradientCodeDesktop = desktopApi;
}
//# sourceMappingURL=preload.js.map