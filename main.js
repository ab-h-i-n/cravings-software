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
// --- ESC/POS HELPER FUNCTIONS ---
function convertOrderToEscPos(order) {
  const ESC = "\x1B";
  const GS = "\x1D";
  const LF = "\x0A";
  
  // Commands
  const INIT = ESC + "@";
  const ALIGN_LEFT = ESC + "a" + "\x00";
  const ALIGN_CENTER = ESC + "a" + "\x01";
  const ALIGN_RIGHT = ESC + "a" + "\x02";
  const BOLD_ON = ESC + "E" + "\x01";
  const BOLD_OFF = ESC + "E" + "\x00";
  const CUT_FULL = GS + "V" + "\x42" + "\x00";
  
  // Constants
  const WIDTH = 48; // 80mm printer standard (Font A usually 48 chars)
  
  // Helpers
  const replaceSpecialChars = (str) => {
    if (!str) return "";
    str = String(str);
    // Replace currency symbols common in this context
    str = str.replace(/₹/g, "Rs.");
    str = str.replace(/€/g, "EUR");
    str = str.replace(/£/g, "GBP");
    str = str.replace(/\$/g, "USD"); // Or keep $ if printer supports it, but safer to strict ascii 
    // Remove other non-ascii
    return str.replace(/[^\x00-\x7F]/g, ""); 
  };


  const text = (str) => replaceSpecialChars(str);
  const textLine = (str) => text(str) + LF;
  
  // Pad left and right text to fit width
  const pair = (left, right) => {
      left = replaceSpecialChars(left);
      right = replaceSpecialChars(right);
      
      const spaceNeeded = WIDTH - left.length - right.length;
      if (spaceNeeded < 1) {
          // If too long, print left, then newline, then right aligned
          return left + LF + " ".repeat(Math.max(0, WIDTH - right.length)) + right + LF;
      }
      return left + " ".repeat(spaceNeeded) + right + LF;
  };

  let buffer = "";

  // 1. Initialize
  buffer += INIT;
  
  // 2. Header
  buffer += ALIGN_CENTER;
  buffer += BOLD_ON;
  buffer += textLine("KITCHEN ORDER TICKET");
  buffer += BOLD_OFF;
  buffer += textLine("-".repeat(WIDTH)); 
  
  // 3. Order Info
  buffer += ALIGN_LEFT;
  buffer += textLine(`Order: ${order.display_id || order.id.slice(0, 8)}`);
  buffer += textLine(`Type : ${order.type}`);
  buffer += textLine(`Date : ${order.created_at}`); 
  
  if(order.notes) {
      buffer += textLine(" ");
      buffer += BOLD_ON + textLine("Order Notes:") + BOLD_OFF;
      buffer += textLine(order.notes);
  }
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 4. Items
  buffer += BOLD_ON + textLine("ITEMS:") + BOLD_OFF;
  
  if (order.items && order.items.length > 0) {
    order.items.forEach(item => {
      // Quantity x Name
      buffer += BOLD_ON; 
      buffer += textLine(`${item.quantity} x ${item.name}`);
      buffer += BOLD_OFF;
      
      // Notes
      if (item.notes) {
        buffer += textLine(`  (Note: ${item.notes})`);
      }
      buffer += LF; 
    });
  } else {
      buffer += textLine("No items found.");
  }
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 5. Footer
  buffer += ALIGN_CENTER;
  buffer += textLine(`Generated at: ${order.generated_at || new Date().toLocaleString()}`);
  
  if (order.display_id && Number(order.display_id) > 0) {
       buffer += textLine(`ID: ${order.id.slice(0, 8)}`);
  }
  
  buffer += LF;
  buffer += textLine("Powered By Cravings");
  
  // 6. Cut
  buffer += LF + LF + LF; // Feed
  buffer += CUT_FULL;
  
  return Buffer.from(buffer, "ascii"); // Use ascii encoding purely
}

function convertBillToEscPos(bill) {
  const ESC = "\x1B";
  const GS = "\x1D";
  const LF = "\x0A";
  
  // Commands
  const INIT = ESC + "@";
  const ALIGN_LEFT = ESC + "a" + "\x00";
  const ALIGN_CENTER = ESC + "a" + "\x01";
  const ALIGN_RIGHT = ESC + "a" + "\x02";
  const BOLD_ON = ESC + "E" + "\x01";
  const BOLD_OFF = ESC + "E" + "\x00";
  const CUT_FULL = GS + "V" + "\x42" + "\x00";
  
  const WIDTH = 48; // 80mm printer standard

  // Helpers
  const replaceSpecialChars = (str) => {
    if (!str) return "";
    str = String(str);
    str = str.replace(/₹/g, "Rs.");
    str = str.replace(/€/g, "EUR");
    str = str.replace(/£/g, "GBP");
    str = str.replace(/\$/g, "USD");
    return str.replace(/[^\x00-\x7F]/g, ""); 
  };
  
  const text = (str) => replaceSpecialChars(str);
  const textLine = (str) => text(str) + LF;
  
  const pair = (left, right) => {
      left = replaceSpecialChars(left);
      right = replaceSpecialChars(right);
      const spaceNeeded = WIDTH - left.length - right.length;
      if (spaceNeeded < 1) {
           return left + LF + " ".repeat(Math.max(0, WIDTH - right.length)) + right + LF;
      }
      return left + " ".repeat(spaceNeeded) + right + LF;
  };

  let buffer = "";

  // 1. Initialize
  buffer += INIT;
  
  // 2. Header (Store Info)
  buffer += ALIGN_CENTER;
  buffer += BOLD_ON;
  buffer += textLine(bill.store_name || "Restaurant");
  buffer += BOLD_OFF;
  if (bill.address) {
      buffer += textLine(bill.address);
  }
  if (bill.phone) buffer += textLine(`Tel: ${bill.phone}`);
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 3. Bill Info
  buffer += ALIGN_LEFT;
  buffer += pair(`Order: ${bill.display_id || bill.id.slice(0, 8)}`, "");
  buffer += pair(`Date : ${bill.created_at}`, `Time: ${bill.time || ""}`);
  
  buffer += pair(`Type : ${bill.type}`, "");
  if(bill.payment_method) buffer += pair(`Pay  : ${bill.payment_method}`, "");
  
  // Customer / Delivery Info
  if (bill.customer_name || bill.customer_phone || bill.delivery_address) {
      buffer += textLine("-".repeat(WIDTH));
      buffer += BOLD_ON + textLine("Customer Details:") + BOLD_OFF;
      if(bill.customer_name) buffer += textLine(`Name: ${bill.customer_name}`);
      if(bill.customer_phone) buffer += textLine(`Ph  : ${bill.customer_phone}`);
      if(bill.delivery_address) {
          buffer += textLine("Address:");
          buffer += textLine(bill.delivery_address);
      }
  }

  // Notes
  if(bill.notes) {
      buffer += textLine("-".repeat(WIDTH));
      buffer += BOLD_ON + textLine("Order Notes:") + BOLD_OFF;
      buffer += textLine(bill.notes);
  }
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 4. Items
  buffer += BOLD_ON + textLine("ITEMS") + BOLD_OFF;
  
  if (bill.order_items && bill.order_items.length > 0) {
      bill.order_items.forEach(item => {
          const itemTotal = (item.quantity * item.price).toFixed(2);
          const left = `${item.quantity} x ${item.name}`;
          const right = itemTotal;
          buffer += pair(left, right);
      });
  }
  
  // 5. Extra Charges
  if(bill.extra_charges && bill.extra_charges.length > 0) {
      buffer += textLine("-".repeat(WIDTH)); 
      bill.extra_charges.forEach(charge => {
          const price = parseFloat(charge.price).toFixed(2);
          buffer += pair(charge.name, price);
      });
  }
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 6. Totals
  const currency = replaceSpecialChars(bill.currency || ""); 
  const calc = bill.calculations;
  
  if(calc) {
    buffer += pair("Subtotal:", `${currency} ${calc.subtotal.toFixed(2)}`);
    if (calc.gst_amount > 0) {
        // Determine tax label (GST or VAT)
        const taxLabel = (bill.country === "United Arab Emirates") ? "VAT" : "GST";
        buffer += pair(`${taxLabel} (${calc.gst_percentage}%):`, `${currency} ${calc.gst_amount.toFixed(2)}`);
    }
    buffer += BOLD_ON;
    buffer += pair("TOTAL:", `${currency} ${calc.grand_total.toFixed(2)}`);
    buffer += BOLD_OFF;
  }
  
  buffer += ALIGN_CENTER;
  buffer += textLine("-".repeat(WIDTH));
  
  // 7. Footer
  buffer += textLine("Thank you for your visit!");
  
  // Tax No
  const taxLabelFooter = (bill.country === "United Arab Emirates") ? "VAT" : "GST";
  if (bill.gst_no) buffer += textLine(`${taxLabelFooter}: ${bill.gst_no}`);
  
  // FSSAI
  if (bill.fssai_licence_no) buffer += textLine(`FSSAI: ${bill.fssai_licence_no}`);
  
  // --- QR CODES ---
  const printQRCode = (data) => {
      // 1. Function 167 (Model 2)
      // GS ( k pL pH cn fn n (Set module size to 3)
      let qrBuf = "";
      qrBuf += GS + "(k" + "\x03\x00" + "\x31" + "\x43" + "\x03"; 
      
      // 2. Function 169 (Error Correction Level L)
      qrBuf += GS + "(k" + "\x03\x00" + "\x31" + "\x45" + "\x30";
      
      // 3. Store Data (Function 180)
      // GS ( k pL pH cn fn m d1...dk
      const len = data.length + 3;
      const pL = len % 256;
      const pH = Math.floor(len / 256);
      
      qrBuf += GS + "(k" + String.fromCharCode(pL) + String.fromCharCode(pH) + "\x31" + "\x50" + "\x30" + data;
      
      // 4. Print Symbol (Function 181)
      qrBuf += GS + "(k" + "\x03\x00" + "\x31" + "\x51" + "\x30";
      return qrBuf;
  };
  
  // Delivery Location QR
  if(bill.delivery_location && bill.delivery_location.google_maps_link) {
      buffer += LF;
      buffer += ALIGN_CENTER;
      buffer += textLine("Scan for Location");
      buffer += printQRCode(bill.delivery_location.google_maps_link);
      buffer += LF;
  }
  
  // UPI Payment QR
  if(bill.payment_upi_string) {
      buffer += LF;
      buffer += ALIGN_CENTER;
      buffer += textLine("Scan to Pay");
      // buffer += textLine(bill.payment_upi_string); // Debug
      buffer += printQRCode(bill.payment_upi_string);
      buffer += LF;
      
      // Amount below QR
      if(calc) {
          buffer +=  textLine(`${currency} ${calc.grand_total.toFixed(2)}`);
      }
  }

  buffer += LF;
  if(bill.show_powered_by_cravings) {
    buffer += textLine("Powered By Cravings");
  }
  
  // 8. Cut
  buffer += LF + LF + LF;
  buffer += CUT_FULL;
  
  return Buffer.from(buffer, "ascii");
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

      backgroundWindow.loadURL(`${url}?print=false&w=72mm`); 
      
      // Capture console messages
      backgroundWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
          
          let orderData = null;
          let escPosBuffer = null;
          let jobName = "print_job";

          // KOT CHECK
          const kotPrefix = "KOT Contents JSON:";
          if (message.startsWith(kotPrefix)) {
              try {
                  const jsonStr = message.substring(kotPrefix.length).trim();
                  orderData = JSON.parse(jsonStr);
                  log.info("Received KOT JSON:", orderData.id);
                  escPosBuffer = convertOrderToEscPos(orderData);
                  jobName = "kot_" + orderData.id;
              } catch (e) {
                  log.error("Error parsing KOT JSON", e);
              }
          }
          
          // BILL CHECK
          const billPrefix = "Bill Contents JSON:";
          if (message.startsWith(billPrefix)) {
              try {
                  const jsonStr = message.substring(billPrefix.length).trim();
                  orderData = JSON.parse(jsonStr);
                  log.info("Received Bill JSON:", orderData.id);
                  escPosBuffer = convertBillToEscPos(orderData);
                  jobName = "bill_" + orderData.id;
              } catch (e) {
                  log.error("Error parsing Bill JSON", e);
              }
          }
          
          if (escPosBuffer) {
              try {
                  // Write to temp file
                  const filename = `temp_${jobName}.bin`;
                  let filePath;
                  if (app.isPackaged) {
                    filePath = path.join(process.resourcesPath, filename);
                  } else {
                    filePath = path.join(__dirname, filename);
                  }
                  
                  fs.writeFileSync(filePath, escPosBuffer);
                  log.info(`Wrote print data to ${filePath}`);
                  
                  // Execute print-raw.exe
                  const exeName = "print-raw.exe";
                  let exePath;

                  if (app.isPackaged) {
                    exePath = path.join(process.resourcesPath, exeName);
                  } else {
                    exePath = path.join(__dirname, exeName);
                  }
                  
                  log.info(`Executing raw printer utility: ${exePath}`);
                  
                  execFile(exePath, [filePath], (err, stdout, stderr) => {
                      if (err) {
                        log.error("Raw printing error:", err);
                        return;
                      }
                      
                      log.info("Raw printing output:", stdout);
                      
                      mainWindow.webContents.send("print-status", {
                        success: true,
                        message: "Print sent successfully! 🖨️"
                      });
                      
                      setTimeout(() => {
                           if (!backgroundWindow.isDestroyed()) backgroundWindow.close();
                      }, 1000);
                  });
              } catch (err) {
                  log.error("Printing Execution Error", err);
              }
          }
      });

      // Cleanup if load fails
      backgroundWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
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
