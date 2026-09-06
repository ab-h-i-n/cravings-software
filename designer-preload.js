// Preload for the Bill Layout window (designer.html). A minimal bridge to the
// main process: load/save the layout, sync it with the account, test-print a
// draft, and pick or fetch images. The engine itself (billTemplate.js) is loaded
// by the page with a <script> tag; nothing here touches Node APIs.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("designer", {
  get: (doc) => ipcRenderer.invoke("bill-template:get", { doc }),
  save: (template, doc) => ipcRenderer.invoke("bill-template:save", template, doc),
  sync: () => ipcRenderer.invoke("bill-template:sync"),
  status: () => ipcRenderer.invoke("bill-template:status"),
  useCustom: (on) => ipcRenderer.invoke("bill-template:use-custom", on),
  test: (template, which, doc) => ipcRenderer.invoke("bill-template:test", { template, which, doc }),
  pickImage: (width) => ipcRenderer.invoke("bill-template:pick-image", { width }),
  fetchImage: (url) => ipcRenderer.invoke("bill-template:fetch-image", url),
  close: () => ipcRenderer.send("designer:close"),
  onStatus: (cb) => ipcRenderer.on("bill-template:status", (_e, status) => cb(status)),
  // Printer Settings asked for a document while the window was already open.
  onOpenDoc: (cb) => ipcRenderer.on("designer:doc", (_e, doc) => cb(doc)),
});
