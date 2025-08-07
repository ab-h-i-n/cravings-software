const { ipcRenderer, contextBridge } = require("electron");

// Expose secure APIs from the preload script to the renderer process (the webpage)
contextBridge.exposeInMainWorld("api", {
  onPrintStatus: (callback) =>
    ipcRenderer.on("print-status", (_event, data) => callback(data)),
  onUpdateStatus: (callback) =>
    ipcRenderer.on("update-status", (_event, data) => callback(data)),
  onWindowStateChange: (callback) =>
    ipcRenderer.on("window-state-changed", (_event, isMaximized) =>
      callback(isMaximized)
    ),
});

// This listener runs when the DOM content of a window is loaded
window.addEventListener("DOMContentLoaded", () => {
  // --- Logic for the HIDDEN PRINT WINDOW ---
  if (
    window.location.href.includes("/bill/") ||
    window.location.href.includes("/kot/")
  ) {
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

    // Wait for the printable content to appear, then notify the main process
    waitForElement("#printable-content", () => {
      console.log("Found #printable-content, sending ready-to-print message.");
      ipcRenderer.send("ready-to-print");
    });
  } else {
    // --- Logic for the MAIN WINDOW ---

    // 1. Inject Toast Notification CSS
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

    // 2. Toast Notification Function
    function showToast({ success, message }) {
      const toast = document.createElement("div");
      toast.className = `electron-toast ${
        success === false ? "error" : "success"
      }`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add("show"), 10);
      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 400);
      }, 4000);
    }
    ipcRenderer.on("print-status", (_event, data) => showToast(data));
    ipcRenderer.on("update-status", (_event, data) => showToast(data));

    // 3. Inject the Custom Title Bar HTML
    const titleBar = document.createElement("div");
    titleBar.id = "custom-title-bar";
    titleBar.innerHTML = `
        <div class="title-logo">
          <svg width="17" height="18" viewBox="0 0 17 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.3255 1.5L9.59708 3.2284C9.18401 3.64982 8.95264 4.2164 8.95264 4.8065C8.95264 5.39661 9.18401 5.96319 9.59708 6.38461L10.9497 7.73727C11.3712 8.15034 11.9378 8.38171 12.5279 8.38171C13.118 8.38171 13.6845 8.15034 14.106 7.73727L15.8344 6.00887" stroke="#EA580C" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10.574 11.2692L1.78168 2.47693C1.48175 2.7708 1.24347 3.12156 1.0808 3.50867C0.918138 3.89578 0.834351 4.31146 0.834351 4.73136C0.834351 5.15126 0.918138 5.56694 1.0808 5.95405C1.24347 6.34117 1.48175 6.69193 1.78168 6.9858L7.26748 12.4716C7.79351 12.9976 8.77044 12.9976 9.37162 12.4716L10.574 11.2692ZM10.574 11.2692L15.8343 16.5296" stroke="#EA580C" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M0.879944 16.3793L5.68941 11.645" stroke="#EA580C" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M13.5799 3.75446L8.31952 9.0148" stroke="#EA580C" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="title-text">Cravings</span>
        </div>
        <div class="window-controls">
          <button id="settings-btn" class="window-control-btn" title="Print Settings">
             <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311a1.464 1.464 0 0 1-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413-1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.858a2.929 2.929 0 0 1 0 5.858z"/></svg>
          </button>
          <button id="minimize-btn" class="window-control-btn" title="Minimize">
             <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M2 8.5h12v-1H2v1z"/></svg>
          </button>
          <button id="maximize-btn" class="window-control-btn" title="Maximize">
             <svg class="icon-maximize" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M3 3v10h10V3H3zm9 9H4V4h8v8z"/></svg>
             <svg class="icon-restore" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M3 5v9h9V5H3zm8 8H4V6h7v7zm-2-9h4v4h-1V3h-4v1h1z"/></svg>
          </button>
          <button id="close-btn" class="window-control-btn" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
          </button>
        </div>
      `;
    document.body.prepend(titleBar);

    // 4. Inject the Title Bar CSS
    const style = document.createElement("style");
    style.textContent = `
        :root { 
          --titlebar-height: 36px;
          --titlebar-bg: #F9F5F0;
          --titlebar-text: #444;
          --control-hover-bg: #EFEAE4;
        }
        body { 
          padding-top: var(--titlebar-height) !important; 
          box-sizing: border-box; 
        }
        #custom-title-bar { 
          position: fixed; top: 0; left: 0; right: 0; 
          height: var(--titlebar-height); 
          background-color: var(--titlebar-bg); 
          color: var(--titlebar-text); 
          display: flex; 
          justify-content: space-between; 
          align-items: center; 
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
          z-index: 9999;
          -webkit-app-region: drag;
        }
        .title-logo {
          display: flex;
          align-items: center;
          padding-left: 12px;
        }
        .title-text { 
          font-weight: 600; 
          font-size: 14px;
          margin-left: 8px;
        }
        .window-controls { 
          display: flex; 
          -webkit-app-region: no-drag;
        }
        .window-control-btn { 
          display: inline-flex;
          justify-content: center;
          align-items: center;
          background: transparent; 
          border: none; 
          color: var(--titlebar-text);
          width: 46px; 
          height: var(--titlebar-height);
          cursor: pointer; 
          transition: background-color 0.2s; 
          outline: none; 
        }
        .window-control-btn:hover { 
          background-color: var(--control-hover-bg); 
        }
        #close-btn:hover { 
          background-color: #E81123; 
          color: #fff; 
        }
        .icon-restore { display: none; }
      `;
    document.head.appendChild(style);

    // 5. Add Event Listeners for Title Bar Controls
    const maximizeBtn = document.getElementById("maximize-btn");
    const maxIcon = maximizeBtn.querySelector(".icon-maximize");
    const restoreIcon = maximizeBtn.querySelector(".icon-restore");

    document
      .getElementById("settings-btn")
      ?.addEventListener("click", () => ipcRenderer.send("open-print-settings"));
    document
      .getElementById("minimize-btn")
      ?.addEventListener("click", () => ipcRenderer.send("minimize-app"));
    maximizeBtn?.addEventListener("click", () => ipcRenderer.send("maximize-app"));
    document
      .getElementById("close-btn")
      ?.addEventListener("click", () => ipcRenderer.send("close-app"));

    // Listen for window state changes to toggle the maximize/restore icon
    ipcRenderer.on("window-state-changed", (_event, isMaximized) => {
      if (isMaximized) {
        maxIcon.style.display = "none";
        restoreIcon.style.display = "inline-flex";
      } else {
        maxIcon.style.display = "inline-flex";
        restoreIcon.style.display = "none";
      }
    });
  }
});