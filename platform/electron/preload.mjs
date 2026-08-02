import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("egoLite", {
  navigate: (url) => ipcRenderer.invoke("ego-lite:navigate", url),
  back: () => ipcRenderer.invoke("ego-lite:back"),
  forward: () => ipcRenderer.invoke("ego-lite:forward"),
  reload: () => ipcRenderer.invoke("ego-lite:reload"),
  importData: () => ipcRenderer.invoke("ego-lite:import-data"),
  setTabGroup: (value) => ipcRenderer.invoke("ego-lite:set-tab-group", value),
  listTabs: () => ipcRenderer.invoke("ego-lite:list-tabs"),
  activateTab: (targetId) =>
    ipcRenderer.invoke("ego-lite:activate-tab", targetId),
  getBrowserState: () => ipcRenderer.invoke("ego-lite:browser-state"),
  onBrowserState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("ego-lite:browser-state", listener);
    return () => ipcRenderer.removeListener("ego-lite:browser-state", listener);
  },
  onImportStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("ego-lite:import-status", listener);
    return () => ipcRenderer.removeListener("ego-lite:import-status", listener);
  },
});
