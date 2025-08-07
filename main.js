const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// 1. Import electron-log
const log = require('electron-log');

let mainWindow;

// --- ERROR LOGGING ---
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
  
  // 2. Configure electron-updater to use electron-log
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';
  log.info('App starting...');

  // The rest of your event listeners are correct
  autoUpdater.on('error', (err) => {
    logError('Auto-update error: ' + (err.message || err));
    mainWindow.webContents.send('update-status', { success: false, message: 'Error during update.' });
  });

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) of Cravings.live is available. Do you want to download it now?`,
      buttons: ['Yes', 'No']
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
        mainWindow.webContents.send('update-status', { success: true, message: 'Downloading update... 🚀' });
      }
    });
  });
  
  autoUpdater.on('update-not-available', () => {
    log.info('Update not available.');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const progressMessage = `Downloaded ${Math.round(progressObj.percent)}%`;
    mainWindow.setProgressBar(progressObj.percent / 100);
    mainWindow.webContents.send('update-status', { success: true, message: progressMessage });
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.setProgressBar(-1);
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
    frame: false,
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('https://cravings.live');

  // --- BACKGROUND PRINTING HANDLER ---
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('/bill/') || url.includes('/kot/')) {
      console.log(`Intercepted URL for printing: ${url}`);

      const backgroundWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
        }
      });

      backgroundWindow.loadURL(`${url}?print=false`);
      const contents = backgroundWindow.webContents;

      ipcMain.once('ready-to-print', (event) => {
        if (event.sender === contents) {
            console.log(`Printing content from ${url}`);
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
                if (!backgroundWindow.isDestroyed()) backgroundWindow.close();
            });
        }
      });
      
      contents.on('did-fail-load', (event, errorCode, errorDescription) => {
          const errorMsg = `Failed to load print URL ${url}. Error: ${errorDescription}`;
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


// --- APP LIFECYCLE EVENTS ---
app.on('ready', () => {
  createWindow();
  checkForUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});