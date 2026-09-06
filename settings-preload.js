// Preload for the Printer Settings window. Exposes a minimal, safe bridge to the
// main process for reading/saving the persisted printer profile and test-printing.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printSettings", {
  get: () => ipcRenderer.invoke("print-config:get"),
  save: (cfg) => ipcRenderer.invoke("print-config:save", cfg),
  test: (which) => ipcRenderer.invoke("print-config:test", which),
  printers: () => ipcRenderer.invoke("print-config:printers"),
  close: () => ipcRenderer.send("settings:close"),
  // Bill layout card: status, the per-PC "Use Customized bill" opt-in, a sync
  // with the account, an ESC/POS test of the active layout, and the Bill
  // Layout window.
  layoutStatus: () => ipcRenderer.invoke("bill-template:status"),
  layoutUseCustom: (on) => ipcRenderer.invoke("bill-template:use-custom", on),
  layoutSync: () => ipcRenderer.invoke("bill-template:sync"),
  layoutTest: () => ipcRenderer.invoke("bill-template:test", { which: "sample" }),
  openDesigner: () => ipcRenderer.send("designer:open"),
  onLayoutStatus: (cb) => ipcRenderer.on("bill-template:status", (_e, status) => cb(status)),
});
