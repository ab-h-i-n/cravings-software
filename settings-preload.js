// Preload for the Printer Settings window. Exposes a minimal, safe bridge to the
// main process for reading/saving the persisted printer profile and test-printing.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printSettings", {
  get: () => ipcRenderer.invoke("print-config:get"),
  save: (cfg) => ipcRenderer.invoke("print-config:save", cfg),
  test: () => ipcRenderer.invoke("print-config:test"),
  close: () => ipcRenderer.send("settings:close"),
});
