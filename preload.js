const { ipcRenderer, contextBridge } = require("electron");

// Expose secure APIs to the renderer process (your web page). This part is correct.
contextBridge.exposeInMainWorld('api', {
  onPrintStatus: (callback) => ipcRenderer.on('print-status', (_event, data) => callback(data)),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, data) => callback(data))
});

// This listener runs when the web page's content is loaded.
window.addEventListener("DOMContentLoaded", () => {

  // Check if this is a print window by looking at the URL.
  if (window.location.href.includes('/bill/') || window.location.href.includes('/kot/')) {
    
    // --- THIS LOGIC RUNS ONLY IN THE HIDDEN PRINT WINDOW ---
    const waitForElement = (selector, callback) => {
      const element = document.querySelector(selector);
      if (element) {
        callback(element);
        return;
      }
      const observer = new MutationObserver((mutations, obs) => {
        const foundElement = document.querySelector(selector);
        if (foundElement) {
          obs.disconnect();
          callback(foundElement);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    };

    waitForElement('#printable-content', () => {
      console.log('Found #printable-content, sending ready-to-print message.');
      ipcRenderer.send('ready-to-print');
    });

  } else {

    // --- THIS LOGIC RUNS ONLY IN THE MAIN WINDOW ---

    // Inject the CSS for toast notifications.
    const toastStyle = document.createElement("style");
    toastStyle.textContent = `
      .electron-toast {
        position: fixed; bottom: 20px; right: 20px; padding: 12px 20px;
        border-radius: 6px; color: #fff; font-family: sans-serif; font-size: 14px;
        z-index: 10000; opacity: 0; transition: all 0.4s ease;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .electron-toast.show { opacity: 1; bottom: 30px; }
      .electron-toast.success { background-color: #28a745; }
      .electron-toast.error { background-color: #dc3545; }
    `;
    document.head.appendChild(toastStyle);

    // Function to create and show a toast.
    function showToast({ success, message }) {
      const toast = document.createElement("div");
      toast.className = `electron-toast ${success === false ? 'error' : 'success'}`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
      }, 4000);
    }

    // *** FIX IS HERE: Use ipcRenderer directly, not window.api ***
    // Listen for events from the main process and show toasts.
    ipcRenderer.on('print-status', (_event, data) => {
        console.log('Print status received in renderer:', data);
        showToast(data);
    });

    ipcRenderer.on('update-status', (_event, data) => {
        console.log('Update status received in renderer:', data);
        showToast(data);
    });

    // Inject the custom title bar HTML.
    const titleBar = document.createElement("div");
    titleBar.id = "custom-title-bar";
    titleBar.innerHTML = `
        <div class="title-text">Cravings (v1.0.9)</div>
        <div class="window-controls">
          <button id="minimize-btn" class="window-control-btn" title="Minimize">—</button>
          <button id="maximize-btn" class="window-control-btn" title="Maximize">🗖</button>
          <button id="close-btn" class="window-control-btn" title="Close">x</button>
        </div>
      `;
    // document.body.prepend(titleBar);
    
    // Inject the custom title bar CSS.
    const style = document.createElement("style");
    style.textContent = `
        :root { --titlebar-height: 32px; }
        body { padding-top: var(--titlebar-height) !important; box-sizing: border-box; }
        #custom-title-bar { position: fixed; top: 0; left: 0; right: 0; height: var(--titlebar-height); background-color: #ffffff; color: #000; display: flex; justify-content: space-between; align-items: center; padding: 0 4px 0 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; z-index: 9999; -webkit-app-region: drag; border-bottom: 1px solid #e0e0e0; }
        .title-text { font-weight: 600; font-size: 14px; }
        .window-controls { display: flex; -webkit-app-region: no-drag; }
        .window-control-btn { background: none; border: none; color: #000; font-size: 16px; width: 40px; height: var(--titlebar-height); line-height: var(--titlebar-height); text-align: center; cursor: pointer; transition: background-color 0.2s; outline: none; }
        .window-control-btn:hover { background-color: #e0e0e0; }
        #close-btn:hover { background-color: #e81123; color: #ffffff; }
      `;
    // document.head.appendChild(style);

    // Add event listeners for the title bar buttons.
    document.getElementById("minimize-btn")?.addEventListener("click", () => ipcRenderer.send("minimize-app"));
    document.getElementById("maximize-btn")?.addEventListener("click", () => ipcRenderer.send("maximize-app"));
    document.getElementById("close-btn")?.addEventListener("click", () => ipcRenderer.send("close-app"));
  }
});