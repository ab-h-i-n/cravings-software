const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;

// --- START: Error Logging Function ---
/**
 * Logs an error message to cravings-log.txt on the desktop.
 * @param {string} error The error message to log.
 */
function logError(error) {
  try {
    const logPath = path.join(app.getPath('desktop'), 'cravings-log.txt');
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ERROR: ${error.toString()}\n`;
    fs.appendFileSync(logPath, logMessage);
    console.error(`Error logged to ${logPath}`);
  } catch (logWriteError) {
    console.error('Fatal: Could not write to log file.', logWriteError);
  }
}
// --- END: Error Logging Function ---


// --- START: New Auto-Update Function ---
function checkForUpdates() {
  // We can use the existing logger for updater errors.
  autoUpdater.on('error', (err) => {
    logError('Auto-update error: ' + (err.message || err));
  });

  // When an update is found
  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) of Cravings.live is available. Do you want to download it now?`,
      buttons: ['Yes', 'No']
    }).then(result => {
      if (result.response === 0) { // If 'Yes' is clicked
        autoUpdater.downloadUpdate();
        mainWindow.webContents.send('update-status', { message: 'Downloading update... 🚀' });
      }
    });
  });
  
  // When the app is already on the latest version
  autoUpdater.on('update-not-available', () => {
    console.log('You are on the latest version.');
    // You could send a message for silent checks if you want:
    // mainWindow.webContents.send('update-status', { message: 'You are on the latest version. ✅' });
  });

  // Track download progress
  autoUpdater.on('download-progress', (progressObj) => {
    const log_message = `Downloaded ${Math.round(progressObj.percent)}%`;
    mainWindow.setProgressBar(progressObj.percent / 100);
    mainWindow.webContents.send('update-status', { message: log_message });
  });
  
  // When the update has been downloaded
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.setProgressBar(-1); // Clear progress bar
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Update for version ${info.version} is downloaded. The application will now restart to install it.`,
      buttons: ['Restart Now']
    }).then(() => {
      autoUpdater.quitAndInstall();
    });
  });
  
  // Initiate the check
  autoUpdater.checkForUpdates();
}
// --- END: New Auto-Update Function ---


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Cravings.live",
    frame: false,
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('https://test.cravings.live');

  // --- Background Print Handler (Unchanged) ---
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('/bill/') || url.includes('/kot/')) {
      console.log(`Intercepted URL: ${url}. Creating a background window.`);

      const backgroundWindow = new BrowserWindow({ show: false });
      backgroundWindow.loadURL(`${url}?print=false`);

      const contents = backgroundWindow.webContents;

      contents.on('did-finish-load', () => {
        try {
          console.log(`Content for ${url} loaded. Initiating print.`);
          contents.print({ silent: true }, (success, failureReason) => {
            if (success) {
              console.log('Print job sent successfully.');
              mainWindow.webContents.send('print-status', { 
                success: true, 
                message: 'Print job sent successfully! 👍' 
              });
            } else {
              console.error(`Print failed: ${failureReason}`);
              logError(`Print failed for URL ${url}. Reason: ${failureReason}`);
              mainWindow.webContents.send('print-status', { 
                success: false, 
                message: `Print failed: ${failureReason}` 
              });
            }
            if (!backgroundWindow.isDestroyed()) backgroundWindow.close();
          });
        } catch (err) {
            logError(`An exception occurred during the print process for ${url}: ${err.message}`);
            if (!backgroundWindow.isDestroyed()) backgroundWindow.close();
        }
      });
      
      contents.on('did-fail-load', (event, errorCode, errorDescription) => {
          const errorMsg = `Failed to load URL ${url} in background window. Error: ${errorDescription} (Code: ${errorCode})`;
          console.error(errorMsg);
          logError(errorMsg);
          if (!backgroundWindow.isDestroyed()) backgroundWindow.close();
      });

      return { action: 'deny' };
    }
    
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Window Control Listeners (Unchanged) ---
ipcMain.on('minimize-app', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-app', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on('close-app', () => {
  if (mainWindow) mainWindow.close();
});

// --- App Lifecycle Handlers ---
app.on('ready', () => {
  createWindow();
  
  // Call the update check function after the window is created.
  checkForUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});