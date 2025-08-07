const { ipcRenderer, contextBridge } = require("electron");

// This part is unchanged. It securely exposes the 'onPrintStatus' function.
contextBridge.exposeInMainWorld('api', {
  onPrintStatus: (callback) => ipcRenderer.on('print-status', (_event, data) => callback(data))
});

// This listener waits for the web page's content to be fully loaded.
window.addEventListener("DOMContentLoaded", () => {

  // --- START: New Toast Notification Code ---

  // 1. Inject the CSS for the toasts into the web page's head.
  const toastStyle = document.createElement("style");
  toastStyle.textContent = `
    .electron-toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 6px;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease-in-out, bottom 0.3s ease-in-out;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .electron-toast.show {
      opacity: 1;
      bottom: 30px;
    }
    .electron-toast.success {
      background-color: #28a745; /* Green for success */
    }
    .electron-toast.error {
      background-color: #dc3545; /* Red for error */
    }
  `;
  document.head.appendChild(toastStyle);

  // 2. Create the function that shows a toast.
  function showToast({ success, message }) {
    const toast = document.createElement("div");
    toast.className = `electron-toast ${success ? 'success' : 'error'}`;
    toast.textContent = message;

    document.body.appendChild(toast);

    // Trigger the "show" class to animate it in.
    setTimeout(() => {
      toast.classList.add('show');
    }, 10); // A small delay is needed for the CSS transition to work.

    // Set a timer to remove the toast after 4 seconds.
    setTimeout(() => {
      toast.classList.remove('show');
      // Remove the element from the DOM after the fade out animation completes.
      setTimeout(() => {
        if (toast.parentElement) {
          toast.parentElement.removeChild(toast);
        }
      }, 300); // This duration should match the transition time.
    }, 4000);
  }

  // 3. Listen for the 'print-status' event and call our new showToast function.
  window.api.onPrintStatus((data) => {
    console.log('Print status received in renderer:', data);
    showToast(data);
  });

  // --- END: New Toast Notification Code ---


  // --- Your existing title bar code (unchanged) ---
  const titleBar = document.createElement("div");
  titleBar.id = "custom-title-bar";
  titleBar.innerHTML = `
      <div class="title-text">Cravings.live</div>
      <div class="window-controls">
        <button id="minimize-btn" class="window-control-btn" title="Minimize">—</button>
        <button id="maximize-btn" class="window-control-btn" title="Maximize">🗖</button>
        <button id="close-btn" class="window-control-btn" title="Close">x</button>
      </div>
    `;
  document.body.prepend(titleBar);

  const style = document.createElement("style");
  style.textContent = `
      :root {
        --titlebar-height: 32px;
        --titlebar-bg: #ffffffff;
        --titlebar-text: #000000ff;
        --control-hover-bg: #e0e0e0;
        --control-close-hover-bg: #e81123;
        --control-close-hover-text: #ffffff;
      }
      body {
        padding-top: var(--titlebar-height) !important;
        box-sizing: border-box;
      }
      #custom-title-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: var(--titlebar-height);
        background-color: var(--titlebar-bg);
        color: var(--titlebar-text);
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0 4px 0 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        z-index: 9999;
        -webkit-app-region: drag; 
      }
      .title-text {
        font-weight: 600;
        font-size: 14px;
      }
      .window-controls {
        display: flex;
        -webkit-app-region: no-drag;
      }
      .window-control-btn {
        background: none;
        border: none;
        color: var(--titlebar-text);
        font-size: 16px;
        font-weight: normal;
        width: 40px;
        height: var(--titlebar-height);
        line-height: var(--titlebar-height);
        text-align: center;
        cursor: pointer;
        transition: background-color 0.2s;
        outline: none;
      }
      .window-control-btn:hover {
        background-color: var(--control-hover-bg);
      }
      #close-btn:hover {
        background-color: var(--control-close-hover-bg);
        color: var(--control-close-hover-text);
      }
    `;
  document.head.appendChild(style);

  const minimizeBtn = document.getElementById("minimize-btn");
  const maximizeBtn = document.getElementById("maximize-btn");
  const closeBtn = document.getElementById("close-btn");

  if (minimizeBtn && maximizeBtn && closeBtn) {
    minimizeBtn.addEventListener("click", () => ipcRenderer.send("minimize-app"));
    maximizeBtn.addEventListener("click", () => ipcRenderer.send("maximize-app"));
    closeBtn.addEventListener("click", () => ipcRenderer.send("close-app"));
  }
});