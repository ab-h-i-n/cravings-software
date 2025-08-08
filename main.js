const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

let mainWindow;
let settingsWindow;

//================================================================//
// --- PERSISTENT PRINT SETTINGS ---
//================================================================//

const settingsPath = path.join(app.getPath("userData"), "print-settings.json");

const defaultSettings = {
  width: 88,
  height: 279,
  scaleFactor: 1.0,
};

let printSettings = loadSettings();

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const settingsData = fs.readFileSync(settingsPath, "utf-8");
      return { ...defaultSettings, ...JSON.parse(settingsData) };
    }
  } catch (error) {
    log.error("Error loading settings, falling back to defaults:", error);
  }
  return defaultSettings;
}

function saveSettings(newSettings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
    printSettings = newSettings;
    log.info("Print settings saved to:", settingsPath);
  } catch (error) {
    log.error("Error saving settings:", error);
  }
}

//================================================================//
// --- ERROR LOGGING ---
//================================================================//

function logError(error) {
  try {
    const logPath = path.join(app.getPath("desktop"), "cravings-log.txt");
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ERROR: ${error.toString()}\n\n`;
    fs.appendFileSync(logPath, logMessage);
  } catch (logWriteError) {
    log.error("Fatal: Could not write to log file.", logWriteError);
  }
}

//================================================================//
// --- AUTO-UPDATER ---
//================================================================//

function checkForUpdates() {
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = "info";
  log.info("App starting...");

  autoUpdater.on("error", (err) => {
    logError("Auto-update error: " + (err.message || err));
  });

  autoUpdater.on("update-available", (info) => {
    mainWindow.webContents.send("update-status", {
      success: true,
      message: "Downloading update... 🚀",
    });
  });

  autoUpdater.on("update-not-available", () => {
    log.info("Update not available.");
  });

  autoUpdater.on("download-progress", (progressObj) => {
    mainWindow.setProgressBar(progressObj.percent / 100);
  });

  autoUpdater.on("update-downloaded", (info) => {
    mainWindow.setProgressBar(-1);
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: `Update for version ${info.version} is downloaded. The application will now restart to install it.`,
        buttons: ["Restart Now"],
      })
      .then(() => {
        autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.checkForUpdates();
}

//================================================================//
// --- BACKGROUND PRINTING ---
//================================================================//

function startBackgroundPrint(printUrl) {
  log.info(`Starting print for ${printUrl} with stored settings:`, printSettings);
  
  // Create a new window for each print job.
  const backgroundWindow = new BrowserWindow({
    show: false, // Keep it hidden
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const contents = backgroundWindow.webContents;

  // IMPORTANT: Create a dedicated function to clean up the window.
  const cleanup = () => {
    // Clear the timeout to prevent it from closing an already closed window.
    clearTimeout(printTimeout);
    // Ensure the window exists and is not already destroyed before closing.
    if (backgroundWindow && !backgroundWindow.isDestroyed()) {
      backgroundWindow.close();
    }
  };

  // Failsafe: If printing takes too long, close the window to prevent leaks.
  const printTimeout = setTimeout(() => {
    log.error(`Print job for ${printUrl} timed out after 20 seconds.`);
    cleanup();
  }, 20000); // 20-second timeout

  ipcMain.once("ready-to-print", (event) => {
    // Ensure the event is from the correct window.
    if (event.sender !== contents) {
      return;
    }
      
    log.info(`Printing content from ${printUrl}`);
    const printOptions = {
      silent: true, // `false` shows the OS print dialog, which is better for debugging.
      printBackground: false,
      pageSize: {
        width: Math.round(printSettings.width * 1000), // mm to micrometers
        height: Math.round(printSettings.height * 1000), // mm to micrometers
      },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      scaleFactor: parseFloat(printSettings.scaleFactor),
    };

    contents.print(printOptions, (success, failureReason) => {
      if (success) {
        log.info("Print job successfully sent to the spooler.");
        mainWindow?.webContents.send("print-status", { success: true, message: "Print job sent! 👍" });
      } else {
        // Don't log "user cancelled" as an error.
        if (failureReason !== "cancelled") {
            log.error(`Print failed: ${failureReason}`);
        }
        mainWindow?.webContents.send("print-status", { success: false, message: `Print failed: ${failureReason}` });
      }

      // **THE CRITICAL FIX**
      // Use a longer delay before cleaning up. 500ms may be too short for some drivers.
      setTimeout(cleanup, 1500); // Increased delay to 1.5 seconds
    });
  });

  contents.on("did-fail-load", (event, errorCode, errorDescription) => {
    log.error(`Failed to load print URL ${printUrl}. Error: ${errorDescription}`);
    // Clean up immediately if the URL fails to load.
    cleanup();
  });

  backgroundWindow.loadURL(`${printUrl}?print=false`);
}

//================================================================//
// --- MAIN WINDOW CREATION ---
//================================================================//

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Cravings",
    frame: false,
    icon: path.join(__dirname, "build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL("https://cravings.live");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes("/bill/") || url.includes("/kot/")) {
      startBackgroundPrint(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state-changed', false));
  
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

//================================================================//
// --- IPC EVENT LISTENERS ---
//================================================================//

ipcMain.on("minimize-app", () => mainWindow?.minimize());
ipcMain.on("maximize-app", () => {
  if (mainWindow) {
    const isMaximized = mainWindow.isMaximized();
    isMaximized ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
ipcMain.on("close-app", () => mainWindow?.close());

ipcMain.on('open-print-settings', () => {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 450,
    height: 350,
    title: "Print Settings",
    parent: mainWindow,
    modal: true,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
    },
  });

  const settingsPageUrl = new URL(`file://${path.join(__dirname, 'print-settings.html')}`);
  settingsPageUrl.searchParams.append('width', printSettings.width);
  settingsPageUrl.searchParams.append('height', printSettings.height);
  settingsPageUrl.searchParams.append('scaleFactor', printSettings.scaleFactor);

  settingsWindow.loadURL(settingsPageUrl.href);
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
});

ipcMain.on('save-print-settings', (event, newSettings) => {
  saveSettings(newSettings);
  if (settingsWindow) settingsWindow.close();
});

ipcMain.on('cancel-print-settings', () => {
  if (settingsWindow) settingsWindow.close();
});

//================================================================//
// --- APP LIFECYCLE ---
//================================================================//

app.on("ready", () => {


  createWindow();
  checkForUpdates();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});