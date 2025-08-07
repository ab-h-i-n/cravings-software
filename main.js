const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;

// --- ERROR LOGGING ---
/**
 * Logs an error message to cravings-log.txt on the desktop.
 * @param {string} error The error message to log.
 */
function logError(error) {
  try {
    const logPath = path.join(app.getPath('desktop'), 'cravings-log.txt');
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ERROR: ${error.toString()}\n\n`;
    fs.appendFileSync(logPath, logMessage);
    console.error(`Error logged to ${logPath}`);
  } catch (logWriteError) {
    console.error('Fatal: Could not write to log file.', logWriteError);
  }
}

// --- AUTO-UPDATE LOGIC ---
function checkForUpdates() {
  // Listen for update errors
  autoUpdater.on('error', (err) => {
    logError('Auto-update error: ' + (err.message || err));
  });

  // Listen for when an update is available
  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) of Cravings.live is available. Do you want to download it now?`,
      buttons: ['Yes', 'No']
    }).then(result => {
      if (result.response === 0) { // If 'Yes' is clicked
        autoUpdater.downloadUpdate();
        mainWindow.webContents.send('update-status', { success: true, message: 'Downloading update... 🚀' });
      }
    });
  });
  
  // Listen for when the app is already on the latest version
  autoUpdater.on('update-not-available', () => {
    console.log('You are on the latest version.');
    // You could optionally send a toast notification for this
    // mainWindow.webContents.send('update-status', { success: true, message: 'You are on the latest version. ✅' });
  });

  // Track the download progress
  autoUpdater.on('download-progress', (progressObj) => {
    const progressMessage = `Downloaded ${Math.round(progressObj.percent)}%`;
    mainWindow.setProgressBar(progressObj.percent / 100); // Show progress in the taskbar
    mainWindow.webContents.send('update-status', { success: true, message: progressMessage });
  });
  
  // Listen for when the update has been fully downloaded
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.setProgressBar(-1); // Clear the progress bar
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Update for version ${info.version} is downloaded. The application will now restart to install it.`,
      buttons: ['Restart Now']
    }).then(() => {
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
    frame: false, // Important for the custom title bar
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('https://test.cravings.live');

  // --- BACKGROUND PRINTING HANDLER ---
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Intercept URLs for bills or KOTs
    if (url.includes('/bill/') || url.includes('/kot/')) {
      console.log(`Intercepted URL for printing: ${url}`);

      // Create a hidden browser window to load the content
      const backgroundWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          // Use the main preload script to detect when the content is ready
          preload: path.join(__dirname, 'preload.js'),
        }
      });

      backgroundWindow.loadURL(`${url}?print=false`);

      const contents = backgroundWindow.webContents;

      // Listen for the 'ready-to-print' message from the preload script
      ipcMain.once('ready-to-print', (event) => {
        // Ensure the event is coming from our background window
        if (event.sender === contents) {
            console.log(`Printing content from ${url}`);
            console.log('Background window contents:');
            contents.print({ silent: true, printBackground: false }, (success, failureReason) => {
                if (success) {
                    console.log('Print job sent successfully.');
                    mainWindow.webContents.send('print-status', { 
                        success: true, 
                        message: 'Print job sent successfully! 👍' 
                    });
                } else {
                    const printErrorMsg = `Print failed for URL ${url}. Reason: ${failureReason}`;
                    console.error(printErrorMsg);
                    logError(printErrorMsg);
                    mainWindow.webContents.send('print-status', { 
                        success: false, 
                        message: `Print failed: ${failureReason}` 
                    });
                }
                // Clean up the background window after printing
                if (!backgroundWindow.isDestroyed()) {
                  backgroundWindow.close();
                }
            });
        }
      });
      
      // Handle cases where the print page fails to load
      contents.on('did-fail-load', (event, errorCode, errorDescription) => {
          const errorMsg = `Failed to load print URL ${url}. Error: ${errorDescription}`;
          console.error(errorMsg);
          logError(errorMsg);
          if (!backgroundWindow.isDestroyed()) {
              backgroundWindow.close();
          }
      });

      return { action: 'deny' }; // Prevent a new visible window from opening
    }
    
    // Allow all other URLs to open normally
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC LISTENERS FOR WINDOW CONTROLS ---
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


// --- APP LIFECYCLE EVENTS ---
app.on('ready', () => {
  createWindow();
  
  // Once the app is ready, check for updates.
  checkForUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});