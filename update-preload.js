// Bridge for update.html: the update window's state and its four buttons.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  getState: () => ipcRenderer.invoke("update:state"),
  onState: (cb) => ipcRenderer.on("update:state", (_e, s) => cb(s)),
  restart: () => ipcRenderer.send("update:restart"),
  later: () => ipcRenderer.send("update:later"),
  retry: () => ipcRenderer.send("update:retry"),
  download: () => ipcRenderer.send("update:download"),
});
