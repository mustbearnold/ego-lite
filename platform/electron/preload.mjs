import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("egoLite", {
  navigate: (url) => ipcRenderer.invoke("ego-lite:navigate", url),
  back: () => ipcRenderer.invoke("ego-lite:back"),
  forward: () => ipcRenderer.invoke("ego-lite:forward"),
  reload: () => ipcRenderer.invoke("ego-lite:reload"),
  toggleTabMute: () => ipcRenderer.invoke("ego-lite:toggle-tab-mute"),
  switchProfile: (value) => ipcRenderer.invoke("ego-lite:switch-profile", value),
  createProfile: (value) => ipcRenderer.invoke("ego-lite:create-profile", value),
  showDownload: (id) => ipcRenderer.invoke("ego-lite:show-download", id),
  setExtension: (value) => ipcRenderer.invoke("ego-lite:set-extension", value),
  importData: () => ipcRenderer.invoke("ego-lite:import-data"),
  setTabGroup: (value) => ipcRenderer.invoke("ego-lite:set-tab-group", value),
  newTab: () => ipcRenderer.invoke("ego-lite:new-tab"),
  newPrivateTab: () => ipcRenderer.invoke("ego-lite:new-private-tab"),
  closeTab: () => ipcRenderer.invoke("ego-lite:close-tab"),
  setSpaceOwnership: (value) =>
    ipcRenderer.invoke("ego-lite:set-space-ownership", value),
  stopSpace: (value) => ipcRenderer.invoke("ego-lite:stop-space", value),
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
  onFocusAddress: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("ego-lite:focus-address", listener);
    return () => ipcRenderer.removeListener("ego-lite:focus-address", listener);
  },
});
