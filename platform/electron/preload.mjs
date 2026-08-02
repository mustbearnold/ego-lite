import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("egoLite", {
  navigate: (url) => ipcRenderer.invoke("ego-lite:navigate", url),
  back: () => ipcRenderer.invoke("ego-lite:back"),
  forward: () => ipcRenderer.invoke("ego-lite:forward"),
  reload: () => ipcRenderer.invoke("ego-lite:reload"),
  getBrowserState: () => ipcRenderer.invoke("ego-lite:browser-state"),
  onBrowserState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("ego-lite:browser-state", listener);
    return () => ipcRenderer.removeListener("ego-lite:browser-state", listener);
  },
});
