import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("egoLite", {
  navigate: (url) => ipcRenderer.invoke("ego-lite:navigate", url),
  back: () => ipcRenderer.invoke("ego-lite:back"),
  forward: () => ipcRenderer.invoke("ego-lite:forward"),
  reload: () => ipcRenderer.invoke("ego-lite:reload"),
  stop: () => ipcRenderer.invoke("ego-lite:stop"),
  savePage: () => ipcRenderer.invoke("ego-lite:save-page"),
  printPage: () => ipcRenderer.invoke("ego-lite:print-page"),
  viewSource: () => ipcRenderer.invoke("ego-lite:view-source"),
  findInPage: (value) => ipcRenderer.invoke("ego-lite:find-in-page", value),
  closeFind: () => ipcRenderer.invoke("ego-lite:close-find"),
  toggleTabMute: () => ipcRenderer.invoke("ego-lite:toggle-tab-mute"),
  switchProfile: (value) => ipcRenderer.invoke("ego-lite:switch-profile", value),
  createProfile: (value) => ipcRenderer.invoke("ego-lite:create-profile", value),
  showDownload: (id) => ipcRenderer.invoke("ego-lite:show-download", id),
  openDownload: (id) => ipcRenderer.invoke("ego-lite:open-download", id),
  toggleBookmark: () => ipcRenderer.invoke("ego-lite:toggle-bookmark"),
  clearHistory: () => ipcRenderer.invoke("ego-lite:clear-history"),
  addReadingList: () => ipcRenderer.invoke("ego-lite:add-reading-list"),
  removeReadingList: (url) =>
    ipcRenderer.invoke("ego-lite:remove-reading-list", url),
  setExtension: (value) => ipcRenderer.invoke("ego-lite:set-extension", value),
  importData: () => ipcRenderer.invoke("ego-lite:import-data"),
  getBrowserSync: () => ipcRenderer.invoke("ego-lite:get-browser-sync"),
  setBrowserSync: (value) =>
    ipcRenderer.invoke("ego-lite:set-browser-sync", value),
  chooseBrowserSyncSource: () =>
    ipcRenderer.invoke("ego-lite:choose-browser-sync-source"),
  syncBrowserData: () => ipcRenderer.invoke("ego-lite:sync-browser-data"),
  setTabGroup: (value) => ipcRenderer.invoke("ego-lite:set-tab-group", value),
  newTab: () => ipcRenderer.invoke("ego-lite:new-tab"),
  newPrivateTab: () => ipcRenderer.invoke("ego-lite:new-private-tab"),
  closeTab: (targetId) => ipcRenderer.invoke("ego-lite:close-tab", targetId),
  reopenClosedTab: () => ipcRenderer.invoke("ego-lite:reopen-closed-tab"),
  setSpaceOwnership: (value) =>
    ipcRenderer.invoke("ego-lite:set-space-ownership", value),
  stopSpace: (value) => ipcRenderer.invoke("ego-lite:stop-space", value),
  listTabs: () => ipcRenderer.invoke("ego-lite:list-tabs"),
  activateTab: (targetId) =>
    ipcRenderer.invoke("ego-lite:activate-tab", targetId),
  getBrowserState: () => ipcRenderer.invoke("ego-lite:browser-state"),
  onActionError: (callback) => {
    const listener = (_event, error) => callback(error);
    ipcRenderer.on("ego-lite:action-error", listener);
    return () => ipcRenderer.removeListener("ego-lite:action-error", listener);
  },
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
  onFocusFind: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("ego-lite:focus-find", listener);
    return () => ipcRenderer.removeListener("ego-lite:focus-find", listener);
  },
  onFindResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("ego-lite:find-result", listener);
    return () => ipcRenderer.removeListener("ego-lite:find-result", listener);
  },
});
