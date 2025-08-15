const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");
const { execFile } = require("child_process");

// 1. Import electron-log
const log = require("electron-log");

let mainWindow;

// --- ERROR LOGGING ---
function logError(error) {
  try {
    const logPath = path.join(app.getPath("desktop"), "cravings-log.txt");
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ERROR: ${error.toString()}\n\n`;
    fs.appendFileSync(logPath, logMessage);
    console.error(`Error logged to ${logPath}`);
  } catch (logWriteError) {
    console.error("Fatal: Could not write to log file.", logWriteError);
  }
}

// --- AUTO-UPDATE LOGIC ---
function checkForUpdates() {
  // 2. Configure electron-updater to use electron-log
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = "info";
  log.info("App starting...");

  // The rest of your event listeners are correct
  autoUpdater.on("error", (err) => {
    logError("Auto-update error: " + (err.message || err));
    mainWindow.webContents.send("update-status", {
      success: false,
      message: "Error during update.",
    });
  });

  autoUpdater.on("update-available", (info) => {
    autoUpdater.downloadUpdate();
    mainWindow.webContents.send("update-status", {
      success: true,
      message: "Downloading update... 🚀",
    });
  });

  autoUpdater.on("update-not-available", () => {
    log.info("Update not available.");
  });

  autoUpdater.on("download-progress", (progressObj) => {
    const progressMessage = `Downloading new update - ${Math.round(
      progressObj.percent
    )}%`;
    mainWindow.setProgressBar(progressObj.percent / 100);
    mainWindow.webContents.send("update-status", {
      success: true,
      message: progressMessage,
    });
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

  // Initiate the check for updates
  autoUpdater.checkForUpdates();
}

// --- MAIN APPLICATION WINDOW ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Cravings.live",
    frame: true,
    icon: path.join(__dirname, "build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null); // This will remove the menu bar

  mainWindow.loadURL("https://cravings.live/");

  // --- BACKGROUND PRINTING HANDLER ---
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes("/bill/") || url.includes("/kot/")) {
      console.log(`Intercepted URL for printing: ${url}`);

      const backgroundWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
        },
        parent: mainWindow,
      });

      backgroundWindow.loadURL(`${url}?print=false`);
      const contents = backgroundWindow.webContents;

      ipcMain.once("ready-to-print", async (event) => {
        if (event.sender === contents) {
          try {
            log.info(`Printing content from ${url}`);

            const filename = "temp_print.png";
            let filePath;

            if (app.isPackaged) {
              // In production, the temp file is in the 'resources' folder
              filePath = path.join(process.resourcesPath, filename);
            } else {
              // In development, the temp file is in the project root
              filePath = path.join(__dirname, filename);
            }

            if (!fs.existsSync(filePath)) {
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
            }
            const imgPath = filePath;

            //save only #printable-content
            const rect = await contents.executeJavaScript(`
            const element = document.querySelector('#printable-content');
            const rect = element.getBoundingClientRect();
            ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          `);
            await contents.capturePage(rect).then((image) => {
              fs.writeFileSync(imgPath, image.toPNG());
            });

            log.info(`Page saved as: ${imgPath}`);

            // Print using C# exe
            const exeName = "print.exe";
            let exePath;

            if (app.isPackaged) {
              // In production, the .exe is in the 'resources' folder
              exePath = path.join(process.resourcesPath, exeName);
            } else {
              // In development, it's in the project root
              exePath = path.join(__dirname, exeName);
            }

            log.info(`Attempting to run executable from: ${exePath}`);

            execFile(exePath, ["", imgPath], (err, stdout, stderr) => {
              if (err) {
                log.error("Printing error:", err);
                return;
              }
              log.info("Printed successfully");
              mainWindow.webContents.send("print-status", {
                success: true,
                message: "Print job sent successfully! 👍",
              });
              // Optionally delete the temp file
              // fs.unlinkSync(imgPath);
            });
          } catch (error) {
            log.error("Printing error:", error);
            mainWindow.webContents.send("print-status", {
              success: false,
              message: "Failed to send print job. 😞",
            });
          }
        }
      });

      contents.on("did-fail-load", (event, errorCode, errorDescription) => {
        const errorMsg = `Failed to load print URL ${url}. Error: ${errorDescription}`;
        console.error(errorMsg);
        logError(errorMsg);
        if (!backgroundWindow.isDestroyed()) backgroundWindow.close();
      });

      return { action: "deny" };
    }

    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- Window Control Listeners (Unchanged) ---
ipcMain.on("minimize-app", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("maximize-app", () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on("close-app", () => {
  if (mainWindow) mainWindow.close();
});

// --- APP LIFECYCLE EVENTS ---
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
