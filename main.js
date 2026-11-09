const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, net, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// 1.6.13: Cravings.live is now Menuthere (build.productName). The data folder
// (sign-in, printers, layouts, logs) is named after the package name,
// "cravings-desktop", which stays as it is, so every install keeps its data
// across the rename. Never rename "name" in package.json.
const { autoUpdater } = require("electron-updater");
const { execFile } = require("child_process");
const { arabicLabelScript } = require("./arabicLabels");
const { buildInvoiceHtml } = require("./billInvoice");
const { buildUaeInvoiceHtml } = require("./billInvoiceUae");
const { deliveryBoyScript } = require("./deliveryBoyBlock");
const BillTemplate = require("./billTemplate");
const StarGraphic = require("./starGraphic");

// 1. Import electron-log
const log = require("electron-log");

// --- LEGACY WINDOWS (7 / 8 / 8.1) SUPPORT ---
// Windows 7 reports 6.1, Windows 8.1 reports 6.3; Windows 10+ reports 10.x.
// These machines run the 32-bit legacy build (packaged with Electron 22, the last
// version supporting Win7). Old GPU drivers there frequently break offscreen
// compositing, which would make capturePage() return blank receipts, so render on
// the CPU instead. Must be called before the app is ready.
const IS_LEGACY_WINDOWS =
  process.platform === "win32" && parseInt(require("os").release().split(".")[0], 10) < 10;
if (IS_LEGACY_WINDOWS) {
  app.disableHardwareAcceleration();
}

let mainWindow;

// --- ERROR LOGGING ---
function logError(error) {
  try {
    const logPath = path.join(app.getPath("desktop"), "menuthere-log.txt");
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ERROR: ${error.toString()}\n\n`;
    fs.appendFileSync(logPath, logMessage);
    console.error(`Error logged to ${logPath}`);
  } catch (logWriteError) {
    console.error("Fatal: Could not write to log file.", logWriteError);
  }
}

// --- CRASH VISIBILITY ---
// The app was reported "crashing" with nothing in the logs, which left no way to
// tell a real crash from the window merely losing focus. Record the things that
// can take it down, so next time there is evidence instead of a guess.
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err);
  logError(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
  logError(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
app.on("render-process-gone", (_e, _wc, details) => {
  log.error("Renderer gone:", details);
  logError(`Renderer gone: ${JSON.stringify(details)}`);
});
app.on("child-process-gone", (_e, details) => {
  log.error("Child process gone:", details);
  logError(`Child process gone: ${JSON.stringify(details)}`);
});

// --- AUTO-UPDATE LOGIC ---
// A small Menuthere window shows the download (progress, size, speed), then
// "Restart now" / "Later" (Later installs on the next quit), and on a failure
// says what went wrong with a way through: try again, or download the
// installer. Background check failures (offline, no release for this OS) stay
// in the log; the window only appears once an update is actually found.
const RELEASES_URL = "https://github.com/ab-h-i-n/cravings-software/releases/latest";
let updateWindow = null;
let updateState = null;
let updateListenersSet = false;

function updateLogo() {
  try {
    return nativeImage.createFromPath(path.join(__dirname, "build/icon.png")).resize({ width: 80 }).toDataURL();
  } catch (e) {
    return "";
  }
}

function setUpdateState(state, { show = true } = {}) {
  updateState = { ...state, logo: updateLogo() };
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send("update:state", updateState);
    return;
  }
  if (!show) return;
  updateWindow = new BrowserWindow({
    width: 440,
    height: 236,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: "Menuthere update",
    icon: path.join(__dirname, "build/icon.png"),
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    show: false,
    webPreferences: { preload: path.join(__dirname, "update-preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  updateWindow.setMenuBarVisibility(false);
  updateWindow.loadFile(path.join(__dirname, "update.html"));
  updateWindow.once("ready-to-show", () => updateWindow && !updateWindow.isDestroyed() && updateWindow.show());
  updateWindow.on("closed", () => { updateWindow = null; });
}

ipcMain.handle("update:state", () => updateState);
ipcMain.on("update:later", () => {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
});
ipcMain.on("update:retry", () => {
  setUpdateState({ phase: "downloading", version: updateState && updateState.version, percent: 0 });
  autoUpdater.checkForUpdates().catch((e) => log.warn("Update retry failed:", e && e.message));
});
ipcMain.on("update:download", () => {
  shell.openExternal(RELEASES_URL).catch(() => {});
});
ipcMain.on("update:restart", () => {
  setUpdateState({ ...updateState, phase: "installing" });
  // Let the window paint, then quit and run the installer silently and
  // reopen the app. The tray icon goes first, so nothing holds the app open.
  setTimeout(() => {
    try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch (e) { /* gone */ }
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      log.error("quitAndInstall failed:", e);
      setUpdateState({ ...updateState, phase: "error", detail: String((e && e.message) || e) });
    }
  }, 400);
});

function checkForUpdates() {
  // The published releases are built for Windows 10+ (modern Electron), so a Win7/8
  // machine must stay on its legacy build — auto-updating would replace it with a
  // binary that cannot start. Those machines are updated by re-running the installer.
  if (IS_LEGACY_WINDOWS) {
    log.info("Legacy Windows detected; skipping auto-update (legacy build is updated manually).");
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = "info";
  autoUpdater.autoDownload = false; // downloaded explicitly below, once
  autoUpdater.autoInstallOnAppQuit = true; // "Later" installs on the next quit
  log.info("App starting...");

  if (!updateListenersSet) {
    updateListenersSet = true;

    autoUpdater.on("error", (err) => {
      const detail = String((err && err.message) || err);
      log.error("Auto-update error:", detail);
      // Only in front of the partner when they are watching an update; a
      // background check that fails (offline, no release for this OS) is noise.
      if (updateWindow && !updateWindow.isDestroyed()) {
        setUpdateState({ ...updateState, phase: "error", detail });
      }
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1); } catch (e) { /* gone */ }
    });

    autoUpdater.on("update-available", (info) => {
      log.info(`Update available: ${info.version}`);
      setUpdateState({ phase: "downloading", version: info.version, percent: 0 });
      autoUpdater.downloadUpdate().catch((e) => log.warn("Update download failed:", e && e.message));
    });

    autoUpdater.on("update-not-available", () => {
      log.info("Update not available.");
    });

    autoUpdater.on("download-progress", (p) => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(p.percent / 100); } catch (e) { /* gone */ }
      setUpdateState({
        phase: "downloading",
        version: updateState && updateState.version,
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      }, { show: false });
    });

    autoUpdater.on("update-downloaded", (info) => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1); } catch (e) { /* gone */ }
      setUpdateState({ phase: "ready", version: info.version });
    });
  }

  autoUpdater.checkForUpdates().catch((e) => log.warn("Update check failed:", e && e.message));
}

// --- "CRAVINGS.LIVE IS NOW MENUTHERE" ---
// Shown once, the first time 1.6.13+ runs on a PC that had the app before
// (a print-config.json in the kept data folder). A fresh install never had
// the old name, so it never sees this.
// Held here: a window nothing references can be garbage-collected and vanish.
let rebrandWindow = null;

function showRebrandNoticeOnce() {
  try {
    const flag = path.join(app.getPath("userData"), "rebrand-menuthere-shown");
    if (fs.existsSync(flag)) return;
    fs.writeFileSync(flag, new Date().toISOString());
    if (!fs.existsSync(printConfigPath())) return; // fresh install
    // A small window showing the change: the old logo and name -> the new.
    const notice = (rebrandWindow = new BrowserWindow({
      width: 460,
      height: 340,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: "Cravings.live is now Menuthere",
      icon: path.join(__dirname, "build/icon.png"),
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: false,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    }));
    notice.on("closed", () => { rebrandWindow = null; });
    notice.setMenuBarVisibility(false);
    notice.loadFile(path.join(__dirname, "rebrand.html"));
    notice.once("ready-to-show", () => !notice.isDestroyed() && notice.show());
  } catch (e) {
    log.warn("Rebrand notice skipped:", e.message);
  }
}

// --- MAIN APPLICATION WINDOW ---
// --- ESC/POS HELPER FUNCTIONS ---

// Characters per line for the ESC/POS TEXT path. Font A glyphs are 12 dots wide,
// so a 58mm head (384 dots) fits 32 columns and an 80mm head (576) fits 48. This
// used to be hardcoded to 48, which made every line on a 58mm printer overflow and
// wrap. Derived from the active printer profile so text matches the paper.
function escposCharsPerLine() {
  return printConfig && printConfig.activeType === "58mm" ? 32 : 48;
}

// The web payload formats times with en-GB, i.e. 24-hour ("13:40"). Counter
// staff read the clock, so print 12-hour. Anything that is not a plain HH:MM —
// including a string that already carries am/pm — is passed through untouched.
function to12Hour(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (/[ap]\.?m\.?/i.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return raw;
  let hour = parseInt(m[1], 10);
  if (!Number.isFinite(hour) || hour > 23) return raw;
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return hour + ":" + m[2] + " " + period;
}

// When this receipt was printed — stamped on both the bill and the KOT.
//
// Distinct from the order's own Date/Time at the top: this says when the paper
// came out, which is what tells a reprint apart from the original.
//
// Formatted by hand rather than with toLocaleString(), which follows whatever
// locale the till happens to run under — a 24-hour Windows install was printing
// "16:02:50" while everything else on the receipt was 12-hour.
function generatedStamp(value) {
  const raw = String(value == null ? "" : value).trim();
  if (raw) return raw;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  let hour = d.getHours();
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` +
    `, ${hour}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${period}`;
}

// Break text at spaces instead of letting the printer chop it mid-word.
function escposWrap(str, width) {
  const words = String(str == null ? "" : str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur.length) cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else { lines.push(cur); cur = w; }
    while (cur.length > width) { lines.push(cur.slice(0, width)); cur = cur.slice(width); }
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [""];
}
// "#482913" with the last 4 bold — the order's 6-digit short id, same rule as
// {order_short_id} in a layout: an order without one prints its order number,
// and only an order with neither falls back to the uuid's first 8.
function shortIdEscPos(o, boldOn, boldOff) {
  const code = BillTemplate.FIELDS.find((f) => f.key === "order_short_id").get(o);
  if (!code) return "";
  const cut = Math.max(0, code.length - 4);
  return "#" + code.slice(0, cut) + boldOn + code.slice(cut) + boldOff;
}

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
  const CUT_FULL = cutBytes();
  
  // Constants
  const WIDTH = escposCharsPerLine(); // 58mm = 32 cols, 80mm = 48
  
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
  
  // 3. Table Name / Number — only when there IS one. A delivery or takeaway
  // order has no table, and printing a bold "N/A" between two rules just puts a
  // meaningless line at the top of every such ticket.
  const tableLabelOrder = order.table_name || (order.table_number ? `Table ${order.table_number}` : "");
  if (tableLabelOrder) {
    buffer += ALIGN_CENTER;
    buffer += BOLD_ON;
    buffer += textLine(tableLabelOrder);
    buffer += BOLD_OFF;
    buffer += textLine("-".repeat(WIDTH));
  }

  // 4. Order Info
  buffer += ALIGN_LEFT;
  // The Order line carries the short order ID — that is what matches the
  // dashboard and support tickets. Falls back to the display number only if an
  // order somehow has no id.
  buffer += textLine(`Order: ${shortIdEscPos(order, BOLD_ON, BOLD_OFF)}`);
  buffer += textLine(`Type : ${order.type}`);
  // When the order was placed. The KOT had no time at all, so the kitchen could
  // not tell a fresh ticket from one that had been sitting on the spike.
  if (order.time) buffer += textLine(`Time : ${to12Hour(order.time)}`);
  // When a prebooked order is due ("Thu, 17 Sep, 7:30 PM", from the web
  // payload). Bold: the kitchen must not cook it now. Wrapped because a slot
  // range runs past 32 columns on a 58mm roll.
  if (order.prebooking_time) {
    buffer += BOLD_ON;
    escposWrap(replaceSpecialChars(`Prebooked: ${order.prebooking_time}`), WIDTH)
      .forEach((ln) => { buffer += textLine(ln); });
    buffer += BOLD_OFF;
  }

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
      // Quantity x Name — wrapped at spaces so long names don't get chopped
      // mid-word by the printer's own wrapping.
      buffer += BOLD_ON;
      escposWrap(replaceSpecialChars(`${item.quantity} x ${item.name}`), WIDTH)
        .forEach((ln) => { buffer += textLine(ln); });
      buffer += BOLD_OFF;

      // Notes
      if (item.notes) {
        escposWrap(replaceSpecialChars(`  (Note: ${item.notes})`), WIDTH)
          .forEach((ln) => { buffer += textLine(ln); });
      }
      buffer += LF; 
    });
  } else {
      buffer += textLine("No items found.");
  }
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 5. Footer
  buffer += ALIGN_CENTER;
  // Wrap at spaces: a full date+time runs past 32 columns on a 58mm roll and the
  // printer would otherwise break it mid-word.
  escposWrap(`Generated at: ${generatedStamp(order.generated_at)}`, WIDTH)
    .forEach((ln) => { buffer += textLine(ln); });
  
  if (order.display_id && Number(order.display_id) > 0) {
       buffer += textLine(`ID: ${shortIdEscPos(order, BOLD_ON, BOLD_OFF)}`);
  }
  
  buffer += LF;
  buffer += textLine("Powered By Menuthere");
  
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
  const CUT_FULL = cutBytes();
  
  const WIDTH = escposCharsPerLine(); // 58mm = 32 cols, 80mm = 48

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
      // Wrap at spaces. This was a plain textLine, so a long store address went
      // out as one line and the PRINTER broke it at the column edge, mid-word —
      // Mehroo Kitchen's 177 characters landed as four mangled lines. The
      // customer's address further down has always wrapped this way; the store's
      // own did not.
      escposWrap(replaceSpecialChars(bill.address), WIDTH)
          .forEach((ln) => { buffer += textLine(ln); });
  }
  if (bill.phone) buffer += textLine(`Tel: ${bill.phone}`);
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 3. Table Name / Number — only when there IS one. A delivery or takeaway
  // order has no table, and printing a bold "N/A" between two rules just puts a
  // meaningless line at the top of every such ticket.
  const tableLabelBill = bill.table_name || (bill.table_number ? `Table ${bill.table_number}` : "");
  if (tableLabelBill) {
    buffer += ALIGN_CENTER;
    buffer += BOLD_ON;
    buffer += textLine(tableLabelBill);
    buffer += BOLD_OFF;
    buffer += textLine("-".repeat(WIDTH));
  }

  // 4. Bill Info
  buffer += ALIGN_LEFT;
  // The Order line carries the short order ID — see the KOT note above.
  // Only the short id identifies the order now — the sequential order number was
  // dropped from the bill (as it was from the KOT). It still stands in as the
  // Order value on the odd payload that carries no id at all.
  buffer += textLine(`Order: ${shortIdEscPos(bill, BOLD_ON, BOLD_OFF)}`);
  buffer += pair(`Date : ${bill.created_at}`, `Time: ${to12Hour(bill.time)}`);

  buffer += pair(`Type : ${bill.type}`, "");
  if(bill.payment_method) buffer += pair(`Pay  : ${bill.payment_method}`, "");
  // When a prebooked order is due — same line as the KOT.
  if (bill.prebooking_time) {
    buffer += BOLD_ON;
    escposWrap(replaceSpecialChars(`Prebooked: ${bill.prebooking_time}`), WIDTH)
      .forEach((ln) => { buffer += textLine(ln); });
    buffer += BOLD_OFF;
  }
  
  // Customer / Delivery Info
  if (bill.customer_name || bill.customer_phone || bill.delivery_address) {
      buffer += textLine("-".repeat(WIDTH));
      buffer += BOLD_ON + textLine("Customer Details:") + BOLD_OFF;
      if(bill.customer_name) buffer += textLine(`Name: ${bill.customer_name}`);
      if(bill.customer_phone) buffer += textLine(`Ph  : ${bill.customer_phone}`);
      if(bill.delivery_address) {
          buffer += textLine("Address:");
          // Wrap at spaces — an address is long and the printer would otherwise
          // chop it mid-word at the column limit.
          escposWrap(replaceSpecialChars(bill.delivery_address), WIDTH)
            .forEach((ln) => { buffer += textLine(ln); });
      }
  }

  // Delivery Boy — part of the order details, right under the customer/address
  // block, between two rules. NOT down by the delivery-location QR: that QR is
  // printed in the footer of the text layout, which pushed this to the bottom of
  // the receipt (on the web page the location sits inside Order Details, which is
  // what made the two layouts disagree).
  //
  // The web /bill payload carries `delivery_boy` only when the partner turned the
  // Bill Printing toggle on AND a rider is assigned, so its presence IS the
  // instruction to print; nothing is re-derived here.
  if (bill.delivery_boy && (bill.delivery_boy.name || bill.delivery_boy.phone)) {
      buffer += textLine("-".repeat(WIDTH));
      buffer += BOLD_ON + textLine("Delivery Boy") + BOLD_OFF;
      if (bill.delivery_boy.name) buffer += textLine(`Name: ${bill.delivery_boy.name}`);
      if (bill.delivery_boy.phone) buffer += textLine(`Ph  : ${bill.delivery_boy.phone}`);
      buffer += textLine("-".repeat(WIDTH));
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
  
  // Item | Qty | Amount, drawn by the layout engine so the built-in bill and
  // the default layout print the same table (add-ons: "* Add-on: …", count in Qty).
  if (bill.order_items && bill.order_items.length > 0) {
      buffer += BillTemplate.itemsEscPos(bill, WIDTH, printConfig.activeType);
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
    if (calc.discount_amount > 0) {
      buffer += pair("Discount:", `-${currency} ${calc.discount_amount.toFixed(2)}`);
    }
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

  // Same stamp the KOT carries, wrapped because a full date+time runs past 32
  // columns on a 58mm roll.
  escposWrap(`Generated at: ${generatedStamp(bill.generated_at)}`, WIDTH)
    .forEach((ln) => { buffer += textLine(ln); });
  
  // Tax No
  const taxLabelFooter = (bill.country === "United Arab Emirates") ? "VAT" : "GST";
  if (bill.gst_no) buffer += textLine(`${taxLabelFooter}: ${bill.gst_no}`);
  
  // FSSAI
  if (bill.fssai_licence_no) buffer += textLine(`FSSAI: ${bill.fssai_licence_no}`);
  
  // --- QR CODES ---
  const printQRCode = (data, moduleSize = 3) => {
      // 1. Function 167 (Model 2)
      // GS ( k pL pH cn fn n (Set module size — bigger n = bigger QR)
      const mod = String.fromCharCode(Math.max(1, Math.min(16, moduleSize)));
      let qrBuf = "";
      qrBuf += GS + "(k" + "\x03\x00" + "\x31" + "\x43" + mod;
      
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

  // Bill detail QR (customer scans to open the order online) — toggled in the
  // dashboard's Bill Printing settings (delivery_rules.bill_show_detail_qr).
  if(bill.bill_detail_url) {
      buffer += LF;
      buffer += ALIGN_CENTER;
      buffer += textLine("Scan for bill details");
      // Slightly bigger QR on 80mm paper (wider roll) than on 58mm. Kept modest so
      // the whole symbol prints reliably (a very large QR can come out half-printed).
      const detailQrModule = (printConfig.activeType === "80mm") ? 4 : 3;
      buffer += printQRCode(bill.bill_detail_url, detailQrModule);
      buffer += LF;
  }

  buffer += LF;
  if(bill.show_powered_by_cravings) {
    buffer += textLine("Powered By Menuthere");
  }
  
  // 8. Cut
  buffer += LF + LF + LF;
  buffer += CUT_FULL;
  
  // Two sections in a row each drawing their own rule leaves a doubled line and
  // wastes paper; keep the first, drop the repeat. Only lines that are exactly a
  // rule are touched, so QR payloads and everything else pass through untouched.
  {
    const rule = "-".repeat(WIDTH);
    const parts = buffer.split(LF);
    buffer = parts.filter((ln, i) => !(ln === rule && parts[i - 1] === rule)).join(LF);
  }
  return Buffer.from(buffer, "ascii");
}


// --- RASTER (IMAGE) PRINTING FOR NON-ASCII RECEIPTS (e.g. Arabic) ---
// Thermal printers can't render Arabic from ESC/POS text (no Arabic font, no
// contextual shaping), so when a receipt contains non-ASCII text we rasterize the
// rendered receipt page to a monochrome GS v 0 bitmap and print that instead.
// RASTER_WIDTH is the printhead dot width; the receipt lays out at RASTER_SRC_WIDTH
// (a fixed fraction of it) and is zoomed up to RASTER_WIDTH (crisp native re-raster).
// Both are set from the paper profile at startup — see applyPaperProfile().
let RASTER_WIDTH = 576;               // active printhead dot width (set from config)
let RASTER_SRC_WIDTH = 360;           // active layout width = RASTER_WIDTH / scale
const RASTER_THRESHOLD = 160;  // luminance < threshold => black dot
const RASTER_BAND_ROWS = 128;  // split GS v 0 into bands for small printer buffers
const CURRENCY_SYMBOLS_RE = /[₹€£$]/g; // handled by the text path; not "unprintable"

// --- PRINTER PROFILE / SETTINGS (persisted in userData/print-config.json) ---
// The user picks a printer type (58mm/80mm) and tunes width (dots) + scale (text size)
// in the Settings window; both profiles + the active choice are saved and reloaded on
// launch. "width" = printhead dots; "scale" = how much the receipt layout is zoomed up
// (bigger scale = bigger text). Layout width = round(width / scale).
const DEFAULT_PRINT_CONFIG = {
  activeType: "80mm",
  fullArabic: false, // when true, bill/KOT static labels print in Arabic (forces raster)
  // "default" (cravings page) | "invoice" (ZATCA tax-invoice) | "uae" (UAE simplified
  // tax invoice, VAT/Net labels always bilingual).
  billLayout: "default",
  // Silences the looping new-order alarm the dashboard plays (webContents audio).
  muteOrderSound: false,
  // Which Windows printers each document goes to. A LIST, because the same
  // document often has to come out in two places at once — e.g. the counter
  // printer takes both the bill and the KOT while the kitchen printer takes only
  // the KOT. An empty list means "the system default printer", which is what
  // every install did before this existed, so an untouched setup is unchanged.
  // Entries are { name, copies } — copies because a kitchen often wants the same
  // KOT twice on one printer. Empty list = one copy on the system default.
  billPrinters: [],
  kotPrinters: [],
  // How receipts are sent to the printer:
  //   "raster" (default) — render the page to a GS v 0 bitmap. Handles Arabic,
  //                        logos and the invoice/uae bill layouts.
  //   "escpos"           — raw ESC/POS text in the printer's own font. Faster,
  //                        but DEFAULT layout only: no custom layouts, no Arabic,
  //                        no logos (the printer simply cannot render them).
  //                        One layout only: the custom layout prints in
  //                        raster mode.
  printMode: "raster",
  // What the printer speaks:
  //   "escpos" (default) — almost every receipt printer.
  //   "star"             — Star TSP100 / TSP143 (Star Graphic): no fonts, so
  //                        it always prints raster, sent as Star raster.
  printerType: "escpos",
  // 2 once the one-time print-mode migration (loadPrintConfig) has run.
  printModeVersion: 0,
  // Set once by the 1.6.10 migration on a PC that printed its custom layout
  // in ESC/POS mode: it keeps doing so (see escposBlocksTemplate).
  escposCustomLegacy: false,
  // Which paper-cut command ends every job:
  //   "escpos" (default) — GS V 66 0, Epson-style feed + cut.
  //   "star"             — ESC d 2, Star Line Mode full cut. Star printers (e.g.
  //                        TSP650II) ship in Star Line Mode and ignore GS V, so
  //                        the paper feeds but never cuts.
  cutCommand: "escpos",
  // Custom ESC/POS bill layout (Printer Settings -> Bill layout -> Customize...).
  // The layout lives in the partner's account (partners.bill_template) and
  // travels inside every /bill payload; this is the local copy, so a test print
  // works offline and a PC that has not synced yet still prints the last layout
  // it saved. null = never customised -> convertBillToEscPos exactly as before.
  billTemplate: null,
  // Per-PC opt-in ("Use Customized bill" in Printer Settings). Off on every
  // install: a saved layout prints only where this is ticked; until then the
  // built-in bill prints, exactly as before this feature existed.
  billTemplateUseCustom: false,
  // Sync bookkeeping: when the local copy last matched the account, whether a
  // local save is still waiting to be pushed, and when it was last changed.
  billTemplateSyncedAt: null,
  billTemplatePending: false,
  billTemplateUpdatedAt: null,
  // The kitchen ticket's layout, same lifecycle as the bill's (the one
  // "Use Customized bill / kot" switch covers both).
  kotTemplate: null,
  kotTemplateSyncedAt: null,
  kotTemplatePending: false,
  kotTemplateUpdatedAt: null,
  // The dashboard's bill-logo URL, cached from the account so the designer can
  // preview a "store logo" block without a live order.
  billLogoUrl: null,
  // The partner's own store details (name, address, tax numbers, currency,
  // UPI…) so the preview and test print show THEIR bill, not a sample store.
  // Filled from the account sync, or remembered from any bill this PC prints.
  billStore: null,
  profiles: {
    "58mm": { rasterWidth: 384, scale: 1.6 },
    "80mm": { rasterWidth: 576, scale: 1.6 },
  },
};
let printConfig = JSON.parse(JSON.stringify(DEFAULT_PRINT_CONFIG));

const isValidCutCommand = (c) => c === "escpos" || c === "star";
// The bytes that cut the paper on the configured printer (see cutCommand).
function cutBytes() {
  return printConfig.cutCommand === "star" ? "\x1B\x64\x02" : "\x1D\x56\x42\x00";
}

// ---- The dashboard's custom-layout switch (payload custom_layout) ----
// Settings -> Printing -> Layout -> "Print my custom layout" travels in every
// /bill and /kot payload as `custom_layout`: true / false wins over this PC's
// own switch for that document; null (never set on the dashboard) or an older
// web build leaves this PC's switch as it was. Read per order, never stored.
function customLayoutOn(order) {
  const v = order && order.custom_layout;
  return typeof v === "boolean" ? v : !!printConfig.billTemplateUseCustom;
}

// A finished raster job for the configured printer type: as built for an
// ESC/POS printer, or the same pictures in Star Graphic commands.
function forPrinterType(buf) {
  if (!buf || printConfig.printerType !== "star") return buf;
  log.info("Star printer: sending the receipt as Star Graphic raster");
  return StarGraphic.fromEscPos(buf, RASTER_WIDTH);
}

// Bill layouts that render their own HTML from the order JSON (vs "default", which prints
// the live cravings page). Add new custom layouts here + a branch in buildBillLayoutHtml.
const VALID_BILL_LAYOUTS = ["default", "invoice", "uae"];
const isValidBillLayout = (l) => VALID_BILL_LAYOUTS.includes(l);
const isCustomBillLayout = (l) => l === "invoice" || l === "uae";
function buildBillLayoutHtml(order, srcWidth, fullArabic, layout) {
  return layout === "uae"
    ? buildUaeInvoiceHtml(order, srcWidth, fullArabic)
    : buildInvoiceHtml(order, srcWidth, fullArabic);
}

function printConfigPath() {
  return path.join(app.getPath("userData"), "print-config.json");
}

const clampWidth = (w) => Math.min(1200, Math.max(120, Math.round((Number(w) || 384) / 8) * 8));
const clampScale = (s) => Math.min(3, Math.max(1, Math.round((Number(s) || 1.6) * 100) / 100));
// Copies of one document on one printer. 1 when unset (every historical config),
// capped so a stray keystroke cannot dump a roll of paper.
const normalizeCopies = (n) => Math.min(5, Math.max(1, Math.round(Number(n) || 1)));

function loadPrintConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_PRINT_CONFIG));
  try {
    // Strip a UTF-8 BOM first: anything that rewrites this file with a Windows
    // editor / PowerShell Set-Content adds one, and JSON.parse throws on it —
    // which used to silently reset the printer calibration to defaults.
    const raw = fs.readFileSync(printConfigPath(), "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    if (parsed.profiles) {
      for (const k of ["58mm", "80mm"]) {
        if (parsed.profiles[k]) {
          cfg.profiles[k] = {
            rasterWidth: clampWidth(parsed.profiles[k].rasterWidth ?? cfg.profiles[k].rasterWidth),
            scale: clampScale(parsed.profiles[k].scale ?? cfg.profiles[k].scale),
          };
        }
      }
      if (parsed.activeType === "58mm" || parsed.activeType === "80mm") cfg.activeType = parsed.activeType;
      if (typeof parsed.fullArabic === "boolean") cfg.fullArabic = parsed.fullArabic;
      if (typeof parsed.muteOrderSound === "boolean") cfg.muteOrderSound = parsed.muteOrderSound;
      // Three shapes exist in the wild and all must keep working:
      //   "Printer"                     - the original single-name key
      //   ["A", "B"]                    - the plain list
      //   [{ name: "A", copies: 2 }]    - current, with copies
      const printerList = (v) => {
        const raw = Array.isArray(v) ? v : (typeof v === "string" && v.trim() ? [v] : null);
        if (!raw) return null;
        const out = [];
        for (const entry of raw) {
          const name = typeof entry === "string" ? entry.trim()
            : (entry && typeof entry.name === "string" ? entry.name.trim() : "");
          if (!name) continue;
          const copies = normalizeCopies(entry && entry.copies);
          const seen = out.find((o) => o.name === name);
          if (seen) seen.copies = copies; // one entry per printer; last wins
          else out.push({ name, copies });
        }
        return out;
      };
      const bp = printerList(parsed.billPrinters) || printerList(parsed.billPrinter);
      const kp = printerList(parsed.kotPrinters) || printerList(parsed.kotPrinter);
      if (bp) cfg.billPrinters = bp;
      if (kp) cfg.kotPrinters = kp;
      if (parsed.printMode === "raster" || parsed.printMode === "escpos") cfg.printMode = parsed.printMode;
      if (parsed.printerType === "star" || parsed.printerType === "escpos") cfg.printerType = parsed.printerType;
      if (Number(parsed.printModeVersion) === 2) cfg.printModeVersion = 2;
      if (isValidCutCommand(parsed.cutCommand)) cfg.cutCommand = parsed.cutCommand;
      if (isValidBillLayout(parsed.billLayout)) cfg.billLayout = parsed.billLayout;
      const tpl = BillTemplate.normalizeTemplate(parsed.billTemplate);
      if (tpl) cfg.billTemplate = tpl;
      if (typeof parsed.billTemplateUseCustom === "boolean") cfg.billTemplateUseCustom = parsed.billTemplateUseCustom;
      if (typeof parsed.billTemplateSyncedAt === "string") cfg.billTemplateSyncedAt = parsed.billTemplateSyncedAt;
      if (typeof parsed.billTemplatePending === "boolean") cfg.billTemplatePending = parsed.billTemplatePending;
      if (typeof parsed.escposCustomLegacy === "boolean") cfg.escposCustomLegacy = parsed.escposCustomLegacy;
      // One-time (1.6.10): ESC/POS mode now prints only the built-in layout. A
      // PC already printing its custom layout in ESC/POS keeps doing so
      // (escposCustomLegacy). Its print mode is never changed: a PC is often on
      // ESC/POS because its printer cannot print raster at all.
      if (cfg.printModeVersion !== 2) {
        if (cfg.printMode === "escpos" && cfg.billTemplateUseCustom) {
          cfg.escposCustomLegacy = true;
          log.info("Print mode migration: keeping this PC's custom layout in ESC/POS mode");
        }
        cfg.printModeVersion = 2;
        cfg._needsSave = true;
      }
      if (typeof parsed.billTemplateUpdatedAt === "string") cfg.billTemplateUpdatedAt = parsed.billTemplateUpdatedAt;
      const ktpl = BillTemplate.normalizeTemplate(parsed.kotTemplate);
      if (ktpl) cfg.kotTemplate = ktpl;
      if (typeof parsed.kotTemplateSyncedAt === "string") cfg.kotTemplateSyncedAt = parsed.kotTemplateSyncedAt;
      if (typeof parsed.kotTemplatePending === "boolean") cfg.kotTemplatePending = parsed.kotTemplatePending;
      if (typeof parsed.kotTemplateUpdatedAt === "string") cfg.kotTemplateUpdatedAt = parsed.kotTemplateUpdatedAt;
      if (typeof parsed.billLogoUrl === "string" && parsed.billLogoUrl.trim()) cfg.billLogoUrl = parsed.billLogoUrl.trim();
      const store = cleanStore(parsed.billStore);
      if (store) cfg.billStore = store;
    } else {
      // legacy formats: { paperWidthMM: 58 } or { rasterWidth: N }
      if (parsed.paperWidthMM === 58) cfg.activeType = "58mm";
      else if (parsed.paperWidthMM === 80) cfg.activeType = "80mm";
      if (Number(parsed.rasterWidth) > 0) cfg.profiles[cfg.activeType].rasterWidth = clampWidth(parsed.rasterWidth);
    }
    // The layout can be several KB (an embedded logo); log its size, not its body.
    log.info(`Print config loaded: ${JSON.stringify(Object.assign({}, cfg, {
      billTemplate: cfg.billTemplate ? `[${cfg.billTemplate.blocks.length} blocks]` : null,
      kotTemplate: cfg.kotTemplate ? `[${cfg.kotTemplate.blocks.length} blocks]` : null,
    }))}`);
  } catch (e) {
    // Say WHY: this used to be silent, so a corrupt file looked like the
    // calibration had reset itself for no reason.
    log.warn(`Could not read print-config.json (${e.message}); using defaults (80mm)`);
  }
  return cfg;
}

function applyPaperProfile() {
  printConfig = loadPrintConfig();
  if (printConfig._needsSave) {
    delete printConfig._needsSave;
    try { savePrintConfig({}); return; } catch (e) { log.warn("Could not save the print-mode migration:", e.message); }
  }
  const p = printConfig.profiles[printConfig.activeType] || DEFAULT_PRINT_CONFIG.profiles["80mm"];
  RASTER_WIDTH = clampWidth(p.rasterWidth);
  RASTER_SRC_WIDTH = Math.max(1, Math.round(RASTER_WIDTH / clampScale(p.scale)));
  log.info(`Active profile ${printConfig.activeType}: printhead ${RASTER_WIDTH} dots, layout ${RASTER_SRC_WIDTH} px (scale ${clampScale(p.scale)})`);
}

function savePrintConfig(incoming) {
  const clean = { activeType: "80mm", profiles: {} };
  clean.activeType = (incoming && (incoming.activeType === "58mm" || incoming.activeType === "80mm"))
    ? incoming.activeType : printConfig.activeType;
  clean.fullArabic = (incoming && typeof incoming.fullArabic === "boolean")
    ? incoming.fullArabic : printConfig.fullArabic;
  clean.billLayout = (incoming && isValidBillLayout(incoming.billLayout))
    ? incoming.billLayout : printConfig.billLayout;
  clean.muteOrderSound = (incoming && typeof incoming.muteOrderSound === "boolean")
    ? incoming.muteOrderSound : printConfig.muteOrderSound;
  clean.printMode = (incoming && (incoming.printMode === "raster" || incoming.printMode === "escpos"))
    ? incoming.printMode : printConfig.printMode;
  clean.cutCommand = (incoming && isValidCutCommand(incoming.cutCommand))
    ? incoming.cutCommand : printConfig.cutCommand;
  clean.printerType = (incoming && (incoming.printerType === "star" || incoming.printerType === "escpos"))
    ? incoming.printerType : (printConfig.printerType === "star" ? "star" : "escpos");
  clean.printModeVersion = 2;
  clean.escposCustomLegacy = (incoming && typeof incoming.escposCustomLegacy === "boolean")
    ? incoming.escposCustomLegacy : !!printConfig.escposCustomLegacy;
  // Bill layout keys: a key present in `incoming` wins (null clears it),
  // otherwise keep what we have — the settings window sends a partial config.
  const has = (k) => !!incoming && Object.prototype.hasOwnProperty.call(incoming, k);
  const isoOrNull = (v) => (typeof v === "string" && v ? v : null);
  clean.billTemplate = has("billTemplate")
    ? (BillTemplate.normalizeTemplate(incoming.billTemplate) || null) : printConfig.billTemplate;
  clean.billTemplateUseCustom = (incoming && typeof incoming.billTemplateUseCustom === "boolean")
    ? incoming.billTemplateUseCustom : !!printConfig.billTemplateUseCustom;
  clean.billTemplateSyncedAt = has("billTemplateSyncedAt") ? isoOrNull(incoming.billTemplateSyncedAt) : printConfig.billTemplateSyncedAt;
  clean.billTemplatePending = (incoming && typeof incoming.billTemplatePending === "boolean")
    ? incoming.billTemplatePending : !!printConfig.billTemplatePending;
  clean.billTemplateUpdatedAt = has("billTemplateUpdatedAt") ? isoOrNull(incoming.billTemplateUpdatedAt) : printConfig.billTemplateUpdatedAt;
  clean.kotTemplate = has("kotTemplate")
    ? (BillTemplate.normalizeTemplate(incoming.kotTemplate) || null) : printConfig.kotTemplate;
  clean.kotTemplateSyncedAt = has("kotTemplateSyncedAt") ? isoOrNull(incoming.kotTemplateSyncedAt) : printConfig.kotTemplateSyncedAt;
  clean.kotTemplatePending = (incoming && typeof incoming.kotTemplatePending === "boolean")
    ? incoming.kotTemplatePending : !!printConfig.kotTemplatePending;
  clean.kotTemplateUpdatedAt = has("kotTemplateUpdatedAt") ? isoOrNull(incoming.kotTemplateUpdatedAt) : printConfig.kotTemplateUpdatedAt;
  clean.billLogoUrl = has("billLogoUrl")
    ? (typeof incoming.billLogoUrl === "string" && incoming.billLogoUrl.trim() ? incoming.billLogoUrl.trim() : null)
    : printConfig.billLogoUrl;
  clean.billStore = has("billStore") ? cleanStore(incoming.billStore) : printConfig.billStore;
  const cleanPrinters = (v, fallback) => {
    if (!Array.isArray(v)) return fallback;
    const out = [];
    for (const entry of v) {
      const name = typeof entry === "string" ? entry.trim()
        : (entry && typeof entry.name === "string" ? entry.name.trim() : "");
      if (!name) continue;
      const copies = normalizeCopies(entry && entry.copies);
      // One entry per printer — two copies are expressed by `copies`, never by
      // listing the same printer twice.
      const seen = out.find((o) => o.name === name);
      if (seen) seen.copies = copies;
      else out.push({ name, copies });
    }
    return out;
  };
  clean.billPrinters = cleanPrinters(incoming && incoming.billPrinters, printConfig.billPrinters);
  clean.kotPrinters = cleanPrinters(incoming && incoming.kotPrinters, printConfig.kotPrinters);
  for (const k of ["58mm", "80mm"]) {
    const src = (incoming && incoming.profiles && incoming.profiles[k]) || printConfig.profiles[k] || DEFAULT_PRINT_CONFIG.profiles[k];
    clean.profiles[k] = { rasterWidth: clampWidth(src.rasterWidth), scale: clampScale(src.scale) };
  }
  fs.writeFileSync(printConfigPath(), JSON.stringify(clean, null, 2));
  applyPaperProfile();
  return printConfig;
}

// Sample order used by the Test Print (so it works without a live order).
const SAMPLE_ORDER = {
  id: "0000test0-0000-0000-0000-000000000000",
  display_id: 4,
  created_at: "20/07/2026", time: "14:08",
  store_name: "Broast Al basha", address: "Jeddah, Saudi Arabia",
  phone: "0500896589", gst_no: "311444943500003",
  type: "Takeaway", payment_method: "cash", customer_name: null,
  order_items: [
    { name: "Chicken Burger برجر دجاج", price: 8, quantity: 1 },
    { name: "Shrimp Burger برجر جمبري", price: 10, quantity: 2 },
  ],
  calculations: { gst_percentage: 15, gst_amount: 3.65, grand_total: 28.0, discount_amount: 0, subtotal: 28.0 },
  currency: "SAR",
};

// Test print: render a sample receipt through the REAL raster pipeline at the current
// Width + Scale + Layout, so tuning is reflected on paper exactly like a live bill.
// `which` picks the target: "bill" or "kot", so each configured printer can be
// verified on its own rather than guessing which device a test slip came out of.
// `opts` (from the Bill Layout window): { escpos: true } forces the text path,
// `template` prints a draft layout, `order` replaces the sample bill.
async function printTestSlip(which = "bill", opts = {}) {
  const isBill = which !== "kot";
  const testTargets = printersFor(isBill);
  // ESC/POS mode: test the mode that will actually be used — raw text in the
  // printer's own font, through the custom bill layout when one is active.
  // A Star TSP100 has no fonts: its test is always the raster one.
  if ((printConfig.printMode === "escpos" || opts.escpos) && printConfig.printerType !== "star") {
    log.info(`Test print: ESC/POS text mode${opts.template ? " (draft layout)" : ""}`);
    const filename = "temp_printer_test.bin";
    const filePath = app.isPackaged ? path.join(process.resourcesPath, filename) : path.join(__dirname, filename);
    const order = opts.order || (isBill ? SAMPLE_ORDER : sampleKot("delivery"));
    const bytes = opts.template
      ? await buildTemplateEscPos(opts.template, order)
      : (isBill ? await buildEscPosBill(order) : await buildEscPosKot(order));
    fs.writeFileSync(filePath, bytes);
    const exePath = app.isPackaged ? path.join(process.resourcesPath, "print-raw.exe") : path.join(__dirname, "print-raw.exe");
    await sendToPrinters(exePath, filePath, testTargets, `test-${which}`);
    return describeTargets(testTargets);
  }

  const win = new BrowserWindow({
    show: false,
    width: RASTER_WIDTH + 44,
    height: 1400,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  try {
    // Test Print calibrates width/scale (physical). Layout + Full Arabic now come
    // from the dashboard, but the locally-cached print-config values still preview
    // here for machines that used them before the settings moved to the web.
    // A custom layout (a draft from the Bill Layout window, or the one this PC
    // prints with) is tested the way raster mode prints it.
    const testOrder = opts.order || (isBill ? SAMPLE_ORDER : sampleKot("delivery"));
    const testTpl = opts.template || (isBill ? activeBillTemplate(testOrder) : activeKotTemplate(testOrder));
    if (testTpl) {
      log.info(`Test print: raster mode, custom ${isBill ? "bill" : "KOT"} layout${opts.template ? " (draft)" : ""}`);
      const bytes = forPrinterType(await buildTemplateRaster(testTpl, testOrder, win));
      const filename = "temp_printer_test.bin";
      const filePath = app.isPackaged ? path.join(process.resourcesPath, filename) : path.join(__dirname, filename);
      fs.writeFileSync(filePath, bytes);
      const exePath = app.isPackaged ? path.join(process.resourcesPath, "print-raw.exe") : path.join(__dirname, "print-raw.exe");
      await sendToPrinters(exePath, filePath, testTargets, `test-${which}`);
      return describeTargets(testTargets);
    }
    let injectArabic = false;
    if (isCustomBillLayout(printConfig.billLayout)) {
      const html = await buildBillLayoutHtml(SAMPLE_ORDER, RASTER_SRC_WIDTH, printConfig.fullArabic, printConfig.billLayout);
      const tmpHtml = app.isPackaged
        ? path.join(process.resourcesPath, "temp_printer_test.html")
        : path.join(__dirname, "temp_printer_test.html");
      fs.writeFileSync(tmpHtml, html);
      await win.loadFile(tmpHtml);
      injectArabic = false; // built invoice HTML is already bilingual
    } else {
      const scale = Math.round((RASTER_WIDTH / RASTER_SRC_WIDTH) * 100) / 100;
      await win.loadFile(path.join(__dirname, "test-receipt.html"), {
        query: { w: `${RASTER_SRC_WIDTH}px`, dots: String(RASTER_WIDTH), scale: String(scale) },
      });
      injectArabic = printConfig.fullArabic;
    }
    const escPosBuffer = forPrinterType(await captureReceiptRaster(win, injectArabic));
    const filename = "temp_printer_test.bin";
    const filePath = app.isPackaged ? path.join(process.resourcesPath, filename) : path.join(__dirname, filename);
    fs.writeFileSync(filePath, escPosBuffer);
    const exePath = app.isPackaged ? path.join(process.resourcesPath, "print-raw.exe") : path.join(__dirname, "print-raw.exe");
    await sendToPrinters(exePath, filePath, testTargets, `test-${which}`);
    return describeTargets(testTargets);
  } finally {
    if (win && !win.isDestroyed()) win.close();
  }
}

// Which printers a document goes to. An empty selection yields [null], i.e. one
// job with no printer argument — print-raw.exe then uses the Windows default,
// preserving the original behaviour for anyone who never touches the setting.
function printersFor(isBill) {
  const list = (isBill ? printConfig.billPrinters : printConfig.kotPrinters) || [];
  return list.length
    ? list.map((t) => ({ name: t.name, copies: t.copies || 1 }))
    : [{ name: null, copies: 1 }]; // nothing chosen = one copy, system default
}

// Send one already-built payload to each target, sequentially — two jobs racing
// into the same spooler is how you get interleaved receipts.
// Gap between two copies of the SAME document on the SAME printer. Back-to-back
// byte-identical RAW jobs can be coalesced (or one silently dropped) by some
// drivers; a short beat makes each land as its own ticket.
const COPY_GAP_MS = 400;

// "Kitchen-POS x2, Counter-POS" — copies only shown when there is more than one.
function describeTargets(targets) {
  return targets
    .map((t) => `${t.name || "system default"}${(t.copies || 1) > 1 ? ` x${t.copies}` : ""}`)
    .join(", ");
}

// Every raw print job in the app funnels through this one chain. Within a job the
// copies are already sequential, but the KOT and the bill are INDEPENDENT flows
// (separate hidden windows) that finish whenever they finish — so without a
// global queue the bill printed in between the two KOT copies, and the kitchen
// got ticket, receipt, ticket. Serialising app-wide keeps each document's copies
// contiguous and documents in order.
let printJobQueue = Promise.resolve();

function sendToPrinters(exePath, filePath, targets, label) {
  const run = () => sendToPrintersNow(exePath, filePath, targets, label);
  // Both handlers: one failed job must never break the chain for the next.
  printJobQueue = printJobQueue.then(run, run);
  return printJobQueue;
}

function sendToPrintersNow(exePath, filePath, targets, label) {
  // Flatten {name, copies} into one entry per physical ticket, then run the whole
  // lot strictly sequentially — parallel jobs into a single spooler interleave.
  const jobs = [];
  targets.forEach((t) => {
    const copies = Math.max(1, t.copies || 1);
    for (let i = 1; i <= copies; i++) jobs.push({ name: t.name, copy: i, of: copies });
  });

  return jobs.reduce(
    (chain, job, index) =>
      chain.then(
        () =>
          new Promise((resolve) => {
            const where = job.name || "default";
            const which = job.of > 1 ? ` copy ${job.copy}/${job.of}` : "";
            const args = job.name ? [filePath, job.name] : [filePath];
            execFile(exePath, args, (err, stdout) => {
              if (err) {
                // One bad printer must never cost the other tickets.
                log.error(`Raw printing error (${label} -> ${where}${which}):`, err);
              } else {
                log.info(`Raw printing output (${label} -> ${where}${which}):`, stdout);
              }
              // Only pause between copies; no need to slow down the last job.
              if (index < jobs.length - 1) setTimeout(resolve, COPY_GAP_MS);
              else resolve();
            });
          })
      ),
    Promise.resolve()
  );
}

const rasterDelay = (ms) => new Promise((r) => setTimeout(r, ms));

// Let a pending style/size change take effect before capturing.
//
// NB: do NOT use requestAnimationFrame here. These print windows are hidden, and
// a hidden window is not composited, so rAF is throttled to a crawl — using it
// made every capture ~3s slower. Instead force a synchronous layout flush (which
// is what we actually depend on) and give the compositor one short beat. This
// replaces the old flat 450ms + 300ms sleeps.
const waitForPaint = async (win, ms = 90) => {
  try {
    await win.webContents.executeJavaScript(
      "(()=>{const el=document.getElementById('printable-content')||document.body;void el.offsetHeight;return true;})()"
    );
  } catch {
    /* page gone; the delay below is still a safe floor */
  }
  await rasterDelay(ms);
};

// True if any printed text field carries characters the ESC/POS text path can't
// render (anything non-ASCII except the currency symbols it already maps to ASCII).
function receiptHasUnprintable(order, isBill) {
  const parts = [
    order.store_name, order.address, order.notes, order.table_name,
    order.customer_name, order.delivery_address,
  ];
  const items = (isBill ? order.order_items : order.items) || [];
  items.forEach((it) => { parts.push(it && it.name, it && it.notes); });
  (order.extra_charges || []).forEach((c) => parts.push(c && c.name));
  const text = parts.filter(Boolean).join(" ").replace(CURRENCY_SYMBOLS_RE, "");
  return /[^\x00-\x7F]/.test(text);
}

// BGRA bitmap -> the GS v 0 bands only (no init, feed or cut), so a picture can
// also sit between the text lines of a custom bill layout. Transparent pixels
// count as white: Chromium hands back premultiplied BGRA, where a fully
// transparent pixel is (0,0,0,0) — black if alpha were ignored, which would
// print a transparent logo as a solid box. Page captures are opaque, so their
// output is unchanged.
function rasterBands(bgra, w, h) {
  const bytesPerRow = Math.ceil(w / 8);
  const chunks = [];
  for (let y0 = 0; y0 < h; y0 += RASTER_BAND_ROWS) {
    const bandH = Math.min(RASTER_BAND_ROWS, h - y0);
    const header = Buffer.from([
      0x1d, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      bandH & 0xff, (bandH >> 8) & 0xff,
    ]);
    const data = Buffer.alloc(bytesPerRow * bandH);
    for (let y = 0; y < bandH; y++) {
      const srcRow = (y0 + y) * w;
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < w) {
            const idx = (srcRow + x) * 4; // BGRA
            const lum = 0.114 * bgra[idx] + 0.587 * bgra[idx + 1] + 0.299 * bgra[idx + 2] + (255 - bgra[idx + 3]);
            if (lum < RASTER_THRESHOLD) b |= 0x80 >> bit;
          }
        }
        data[y * bytesPerRow + bx] = b;
      }
    }
    chunks.push(header, data);
  }
  return Buffer.concat(chunks);
}

// BGRA bitmap -> a complete ESC/POS raster job (init, bands, feed + cut).
function bitmapToRaster(bgra, w, h) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]), // ESC @ init
    rasterBands(bgra, w, h),
    Buffer.from("\x0a\x0a\x0a\x0a" + cutBytes(), "latin1"), // feed + cut
  ]);
}

// Render the receipt page (already loaded in the hidden window) to a raster buffer.
// injectArabic: swap the static English labels to Arabic before capture. Only needed
// for OLD web builds that render the labels in English — current builds already render
// Arabic themselves (the dashboard's Full Arabic setting drives the /bill + /kot pages),
// and locally-built invoice HTML is already bilingual, so both pass injectArabic=false.
async function captureReceiptRaster(win, injectArabic = false, deliveryBoy = null) {
  // Stage timings: printing speed is the thing partners feel most, so make it
  // measurable instead of guessable.
  const t0 = Date.now();
  const marks = [];
  const mark = (name) => marks.push(`${name}=${Date.now() - t0}ms`);
  win.webContents.setZoomFactor(1);
  // The page fetches its order async ("Loading order details...") -> wait for the
  // receipt element to actually render before capturing.
  const ready = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const el = document.getElementById('printable-content') || document.body;
      if (el && el.getBoundingClientRect().height > 60) return resolve(true);
      if (Date.now() - started > 20000) return resolve(false);
      setTimeout(check, 25); // tight poll: this gates every print
    };
    check();
  })`);
  if (!ready) log.warn("Receipt element did not render before capture");
  mark("content");
  // The page never renders the rider block itself — add it before capturing.
  if (deliveryBoy && (deliveryBoy.name || deliveryBoy.phone)) {
    try {
      const where = await win.webContents.executeJavaScript(deliveryBoyScript(deliveryBoy));
      log.info(`Delivery Boy block: ${where}`);
    } catch (e) {
      log.warn("Delivery Boy block injection failed:", e.message);
    }
  }
  await win.webContents.executeJavaScript("(async()=>{try{await document.fonts.ready}catch(e){}return true})()");
  mark("fonts");
  // Wait for every image (the bill-detail QR data URL, a remote store-logo URL) to
  // be fully DECODED before capturing. img.decode() resolves only once the pixels are
  // ready to paint — `complete`/`naturalWidth` can be true while a large QR is still
  // decoding, which on a slow connection captured a half-drawn QR. Capped at 4s each.
  await win.webContents.executeJavaScript(`(async () => {
    // Only the receipt's own images matter — waiting on unrelated page images just
    // delays the print. Already-decoded ones are skipped outright, and the whole
    // wait shares ONE 2.5s deadline instead of 4s per image.
    const root = document.getElementById('printable-content') || document;
    const imgs = Array.from(root.querySelectorAll('img'))
      .filter((img) => !(img.complete && img.naturalWidth > 0 && img.decoding !== 'async'));
    if (!imgs.length) return true;
    const deadline = new Promise((res) => setTimeout(res, 2500));
    await Promise.race([
      Promise.all(imgs.map((img) =>
        (img.decode ? img.decode() : Promise.resolve()).catch(() => {})
      )),
      deadline,
    ]);
    return true;
  })()`);
  mark("images");
  // Full Arabic: translate the static bill/KOT labels to Arabic before capture
  // (legacy path only — see the injectArabic note above).
  if (injectArabic) {
    try { await win.webContents.executeJavaScript(arabicLabelScript()); }
    catch (e) { log.warn("Arabic label injection failed:", e.message); }
  }
  // Scale the RASTER_SRC_WIDTH layout up to the printhead width via CSS zoom (native
  // re-raster = crisp), then capture and downscale.
  const zoom = RASTER_WIDTH / RASTER_SRC_WIDTH;
  // Pin the layout width first: the dashboard's printer setup arrives with the
  // payload, after the page was laid out. The URL's w= is this same width when
  // nothing changed, so this is a no-op then.
  await win.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('printable-content'); if (el) { if (el.style.width) el.style.width = '${RASTER_SRC_WIDTH}px'; el.style.maxWidth = '${RASTER_SRC_WIDTH}px'; el.style.zoom = String(${RASTER_WIDTH} / ${RASTER_SRC_WIDTH}); } return true; })()`
  );
  // Wait for the zoom to actually paint. Two rAFs land after the next composited
  // frame, which is the real signal — this used to be a flat 450ms sleep that was
  // mostly dead time on every single print.
  await waitForPaint(win);

  const rect = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('printable-content') || document.body;
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  })()`);
  // This Chromium reports getBoundingClientRect UNZOOMED; detect and size to the visual box.
  const zoomed = Math.abs(rect.width - RASTER_WIDTH) < Math.abs(rect.width - RASTER_SRC_WIDTH);
  const visW = zoomed ? rect.width : Math.round(rect.width * zoom);
  const visH = zoomed ? rect.height : Math.ceil(rect.height * zoom);

  win.setContentSize(visW + 60, Math.min(rect.y + visH + 30, 6000));
  await waitForPaint(win); // was a flat 300ms sleep

  mark("layout");
  let img = await win.webContents.capturePage({ x: rect.x, y: rect.y, width: visW, height: visH });
  if (img.getSize().width !== RASTER_WIDTH) img = img.resize({ width: RASTER_WIDTH, quality: "best" });
  mark("capture");
  const size = img.getSize();
  const out = bitmapToRaster(img.toBitmap(), size.width, size.height);
  mark("encode");
  log.info(`[timing] raster ${marks.join(" ")} total=${Date.now() - t0}ms`);
  return out;
}


// --- MAIN APPLICATION WINDOW ---
// --- CUSTOM BILL LAYOUT (ESC/POS) ---
// The layout is designed in the Bill Layout window (designer.html), kept in the
// partner's account (partners.bill_template) and cached in print-config.json.
// In ESC/POS mode the bill is built from it instead of convertBillToEscPos;
// with no layout the old builder runs untouched. billTemplate.js is the engine
// and check-template-default.js proves its default prints today's bill.

// The dashboard window starts at cravings.live and is redirected to
// menuthere.com, and the session cookie belongs to whichever host it ends up
// on — so the sync talks to the window's own origin, not a fixed one.
const API_BASE_FALLBACK = "https://menuthere.com";
const BILL_TEMPLATE_API = "/api/print/bill-template";
function apiBase() {
  try {
    const u = new URL(mainWindow.webContents.getURL());
    if (u.protocol === "https:" && /(^|\.)(cravings\.live|menuthere\.com)$/i.test(u.hostname)) return u.origin;
  } catch (e) { /* window not ready */ }
  return API_BASE_FALLBACK;
}

// ---- This PC on the dashboard (Settings → Printing → Printers) ----
// The printers are managed from the dashboard now. This PC reports its Windows
// printers (POST /api/print/devices, with the dashboard window's cookies) and
// gets back what the dashboard picked: the Bill printer, the KOT printer, how
// many copies, and that printer's print mode, type, paper and size. That is
// written into print-config.json like a change made in the old settings
// window, so printing reads it exactly as before. Until the dashboard picks
// anything (assignment null), this PC keeps its own settings untouched.
function deviceIdPath() {
  return path.join(app.getPath("userData"), "device-id");
}

function deviceId() {
  try {
    const id = fs.readFileSync(deviceIdPath(), "utf8").trim();
    if (id) return id;
  } catch (e) { /* first run */ }
  const id = require("crypto").randomBytes(16).toString("hex");
  try { fs.writeFileSync(deviceIdPath(), id); } catch (e) { log.warn("Could not save the device id:", e.message); }
  return id;
}

// The setup every printer on this PC prints with (the PC has one), in the
// dashboard's terms.
function dashboardSetup() {
  const p = printConfig.profiles[printConfig.activeType] || DEFAULT_PRINT_CONFIG.profiles["80mm"];
  return {
    mode: printConfig.printMode === "escpos" ? "escpos" : "raster",
    type: printConfig.printerType === "star" ? "star" : "escpos",
    paper: printConfig.activeType === "58mm" ? "58mm" : "80mm",
    // 100 % is this app's default 1.6 enlargement.
    // On the dashboard's 10 % steps.
    scale: Math.min(150, Math.max(50, Math.round((clampScale(p.scale) / 1.6) * 10) * 10)),
  };
}

let lastDeviceReport = 0;
async function reportDevice(force = false) {
  if (!force && Date.now() - lastDeviceReport < 5 * 60 * 1000) return;
  try {
    const { printers } = await listPrinters();
    const setup = dashboardSetup();
    const res = await apiRequest("POST", "/api/print/devices", {
      device_id: deviceId(),
      name: require("os").hostname(),
      platform: process.platform === "darwin" ? "mac" : "windows",
      app_version: app.getVersion(),
      printers: printers.map((pr) => ({
        id: pr.name, name: pr.displayName || pr.name, connection: "windows", is_default: !!pr.isDefault, ...setup,
      })),
    });
    if (!res.ok) {
      if (res.status !== 401) log.warn(`Device report failed: ${res.status || res.error}`);
      return;
    }
    lastDeviceReport = Date.now();
    applyDashboardAssignment(res.json && res.json.assignment);
  } catch (e) {
    log.warn("Device report failed:", e.message);
  }
}

function applyDashboardAssignment(a) {
  if (!a || typeof a !== "object") return; // the dashboard leaves this PC alone
  const next = { ...printConfig, profiles: JSON.parse(JSON.stringify(printConfig.profiles)) };
  const list = (targets) => (Array.isArray(targets) ? targets : [])
    .filter((d) => d && typeof d.printer_id === "string" && d.printer_id)
    .map((d) => ({ name: d.printer_id, copies: normalizeCopies(d.copies) }));
  let setupId = null;
  if (a.manual === false) {
    // "Auto": the Windows default printer (an empty list), for both, with
    // the setup the dashboard keeps for that printer.
    next.billPrinters = [];
    next.kotPrinters = [];
    setupId = (a.printers && Object.keys(a.printers)[0]) || null;
  } else if (a.manual === true) {
    // Every ticked printer, each with its own copies. Nothing ticked for a
    // document = the Windows default printer, as an empty list always meant.
    next.billPrinters = list(a.bill_targets);
    next.kotPrinters = list(a.kot_targets);
    setupId = (next.billPrinters[0] || next.kotPrinters[0] || {}).name || null;
  } else {
    // A save from before printer lists: one printer per document.
    const bill = list(a.bill ? [a.bill] : []);
    const kot = list(a.kot ? [a.kot] : []);
    if (bill.length) next.billPrinters = bill;
    if (kot.length) next.kotPrinters = kot;
    setupId = (a.bill && a.bill.printer_id) || (a.kot && a.kot.printer_id) || null;
  }
  // One print mode per PC: the first bill printer's setup (else the KOT's).
  const st = setupId && a.printers && a.printers[setupId];
  if (st && typeof st === "object") {
    next.printMode = st.mode === "escpos" ? "escpos" : "raster";
    next.printerType = st.type === "star" ? "star" : "escpos";
    next.activeType = st.paper === "58mm" ? "58mm" : "80mm";
    const pct = Math.min(150, Math.max(50, Math.round(Number(st.scale)) || 100));
    next.profiles[next.activeType] = { ...next.profiles[next.activeType], scale: clampScale(1.6 * pct / 100) };
  }
  const keys = ["billPrinters", "kotPrinters", "printMode", "printerType", "activeType", "profiles"];
  if (keys.every((k) => JSON.stringify(next[k]) === JSON.stringify(printConfig[k]))) return;
  log.info(`Dashboard printer setup applied: bill=${JSON.stringify(next.billPrinters)} kot=${JSON.stringify(next.kotPrinters)} mode=${next.printMode} type=${next.printerType} paper=${next.activeType}`);
  savePrintConfig(next);
}

// Printer Settings opens the dashboard's Printing settings in the app window.
function openPrinterSettings() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.loadURL(`${apiBase()}/admin-v3?view=Settings&sg=printing&ss=devices`);
      reportDevice(true);
      return;
    }
  } catch (e) {
    log.warn("Could not open the dashboard's printer settings:", e.message);
  }
  openSettingsWindow();
}

// The last bill / KOT this PC printed, kept in memory only, so a test print can
// use a real order instead of the sample.
let lastBillPayload = null;
let lastKotPayload = null;

// The two documents share one lifecycle; these are their config keys.
const DOC_KEYS = {
  bill: { template: "billTemplate", pending: "billTemplatePending", syncedAt: "billTemplateSyncedAt", updatedAt: "billTemplateUpdatedAt", apiKey: "template", apiField: "template" },
  kot: { template: "kotTemplate", pending: "kotTemplatePending", syncedAt: "kotTemplateSyncedAt", updatedAt: "kotTemplateUpdatedAt", apiKey: "kotTemplate", apiField: "kotTemplate" },
};
const docOf = (doc) => (doc === "kot" ? "kot" : "bill");
let settingsWindow = null;
let designerWindow = null;

// The store block of a bill: what the account sync returns, and what a printed
// bill carries. Only plain strings/booleans, nothing else is kept.
const STORE_STRING_KEYS = ["store_name", "address", "phone", "gst_no", "fssai_licence_no", "trn", "currency", "country", "upi_id", "logo_url"];
function cleanStore(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of STORE_STRING_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 500);
  }
  if (!out.store_name) return null;
  out.show_payment_qr = !!raw.show_payment_qr;
  out.bill_show_detail_qr = !!raw.bill_show_detail_qr;
  return out;
}

// A printed bill knows everything about the store; keep that, so the preview
// shows the partner's own bill from the first print on, even offline.
function rememberStoreFromBill(bill) {
  if (!bill || !bill.store_name) return;
  const store = cleanStore({
    store_name: bill.store_name,
    address: bill.address,
    phone: bill.phone,
    gst_no: bill.gst_no,
    fssai_licence_no: bill.fssai_licence_no,
    trn: bill.trn,
    currency: bill.currency,
    country: bill.country,
    upi_id: (String(bill.payment_upi_string || "").match(/[?&]pa=([^&]+)/) || [])[1] || "",
    logo_url: bill.store_logo_url || bill.bill_logo_url || "",
    show_payment_qr: !!bill.payment_upi_string,
    bill_show_detail_qr: !!bill.bill_detail_url,
  });
  if (!store) return;
  if (JSON.stringify(store) === JSON.stringify(printConfig.billStore)) return;
  savePrintConfig({ ...printConfig, billStore: store });
}

// The sample order the designer previews and test-prints: sample lines, the
// partner's own store. `kind` picks delivery (default), takeaway or dine_in so
// the layout's conditions can be seen for each. Falls back to the built-in
// sample store until this PC has synced with the account or printed a bill
// (then it says so).
function sampleBill(kind) {
  const base = BillTemplate.SAMPLE_BILLS[kind] || BillTemplate.SAMPLE_BILL;
  const b = Object.assign({}, base, { generated_at: "" });
  const st = printConfig.billStore;
  if (!st) {
    b.store_logo_url = printConfig.billLogoUrl || null;
    b.bill_logo_url = printConfig.billLogoUrl || null;
    b.sample_store = true;
    return b;
  }
  b.store_name = st.store_name;
  b.address = st.address || "";
  b.phone = st.phone || "";
  b.gst_no = st.gst_no || null;
  b.fssai_licence_no = st.fssai_licence_no || null;
  b.trn = st.trn || null;
  b.currency = st.currency || b.currency;
  b.country = st.country || b.country;
  b.payment_upi_string = st.show_payment_qr && st.upi_id
    ? `upi://pay?pa=${st.upi_id}&pn=${encodeURIComponent(st.store_name)}&am=${Number(b.calculations.grand_total).toFixed(2)}&cu=INR`
    : null;
  b.bill_detail_url = st.bill_show_detail_qr ? b.bill_detail_url : null;
  b.store_logo_url = st.logo_url || printConfig.billLogoUrl || null;
  b.bill_logo_url = b.store_logo_url;
  b.sample_store = false;
  return b;
}

// Which layout a bill prints with: the account's copy travelling in the payload
// (freshest), else this PC's copy, else none — which means the built-in bill.
// ESC/POS mode prints the built-in layout only (the custom layout is a raster
// layout), except on a PC that already printed its custom layout in ESC/POS
// before 1.6.10 (escposCustomLegacy): it keeps printing exactly that.
function escposBlocksTemplate() {
  return printConfig.printMode === "escpos" && printConfig.printerType !== "star" && !printConfig.escposCustomLegacy;
}

function activeBillTemplate(bill) {
  if (!customLayoutOn(bill)) return null; // not switched on
  if (escposBlocksTemplate()) return null;
  const fromPayload = bill && bill.bill_template ? BillTemplate.normalizeTemplate(bill.bill_template) : null;
  return fromPayload || printConfig.billTemplate || null;
}

async function buildEscPosBill(bill) {
  const tpl = activeBillTemplate(bill);
  if (!tpl) return convertBillToEscPos(bill);
  try {
    return await buildTemplateEscPos(tpl, bill);
  } catch (e) {
    // A broken layout must never cost a partner a bill.
    log.error("Custom bill layout failed; printing the built-in layout instead", e);
    return convertBillToEscPos(bill);
  }
}

// The kitchen ticket: same rules as the bill, its own layout and fallback.
function activeKotTemplate(order) {
  if (!customLayoutOn(order)) return null;
  if (escposBlocksTemplate()) return null;
  const fromPayload = order && order.kot_template ? BillTemplate.normalizeTemplate(order.kot_template) : null;
  return fromPayload || printConfig.kotTemplate || null;
}

async function buildEscPosKot(order) {
  const tpl = activeKotTemplate(order);
  if (!tpl) return convertOrderToEscPos(order);
  try {
    return await buildTemplateEscPos(tpl, order);
  } catch (e) {
    log.error("Custom KOT layout failed; printing the built-in ticket instead", e);
    return convertOrderToEscPos(order);
  }
}

async function buildTemplateEscPos(tpl, bill) {
  const cols = escposCharsPerLine();
  const lines = BillTemplate.resolveBill(tpl, bill, { paper: printConfig.activeType });
  await resolveImageLines(lines);
  const phys = BillTemplate.fitLines(lines, cols);
  return Buffer.from(BillTemplate.physToEscPos(phys, { paper: printConfig.activeType, cut: cutBytes() }), "latin1");
}

// Raster mode with a custom layout: the same layout as the ESC/POS path, but its
// text is drawn as pictures in the hidden window, so Chinese / Arabic names and
// symbols like "×" print instead of being dropped by the printer's font. QR codes,
// logos and the cut still go out as the ESC/POS path sends them. Every run of text
// between two of those is one picture, the full printhead wide.
async function buildTemplateRaster(tpl, bill, win) {
  const paperCols = escposCharsPerLine();
  const paper = printConfig.activeType;
  // The dashboard's Size (Configure → Size, 50-150 %), as on Android
  // (StarGraphic.layoutColsFor): bigger lays the layout out on fewer columns,
  // so each character is wider across the same paper; smaller keeps the
  // columns and draws them narrower, centred, for a printer that cuts off
  // the edges.
  const pct = dashboardSetup().scale;
  const cols = pct <= 100 ? paperCols : Math.max(16, Math.round((paperCols * 100) / pct));
  // Keep every character: the picture can draw what the printer's font can't.
  const keepAll = (v) => (v == null ? "" : String(v));
  const lines = BillTemplate.resolveBill(tpl, bill, { paper, sanitize: keepAll });
  await resolveImageLines(lines);
  const phys = BillTemplate.fitLines(lines, cols);

  // [{ run: [lines] } | { line }] in print order.
  const parts = [];
  phys.forEach((line) => {
    if (line.t === "qr" || line.t === "image" || line.t === "cut") { parts.push({ line }); return; }
    const last = parts[parts.length - 1];
    if (last && last.run) last.run.push(line);
    else parts.push({ run: [line] });
  });
  const runs = parts.filter((p) => p.run);

  const W = RASTER_WIDTH;
  // The width the text is drawn on: the whole printhead, or less when smaller.
  const inner = pct < 100 ? Math.round((W * pct) / 100) : W;
  const pad = Math.floor((W - inner) / 2);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin:0; padding:0; background:#fff; }
    .run { width:${W}px; box-sizing:border-box; padding-left:${pad}px; color:#000; font-family:Consolas,"Courier New",monospace; overflow:hidden; }
    .pl { white-space:pre; transform-origin:0 50%; }
    .b { font-weight:700; }
    .u { text-decoration:underline; }
    .inv { background:#000; color:#fff; }
    .wrap-wide { display:inline-block; vertical-align:bottom; text-align:left; }
    .wrap-wide > span { display:inline-block; transform-origin:0 100%; }
    .sz-wide { transform:scaleX(2); }
    .sz-big { transform:scale(2,2); }
    .sz-tall { display:inline-block; transform:scaleY(2); transform-origin:0 100%; }
    #probe { position:absolute; visibility:hidden; white-space:pre; font-family:Consolas,"Courier New",monospace; font-size:20px; }
  </style></head><body><span id="probe">${"0".repeat(cols)}</span>${
    runs.map((p, i) => `<div class="run" id="run-${i}">${BillTemplate.physToHtml(p.run, { paper })}</div>`).join("")
  }</body></html>`;
  const tmpHtml = app.isPackaged
    ? path.join(process.resourcesPath, "temp_template_raster.html")
    : path.join(__dirname, "temp_template_raster.html");
  fs.writeFileSync(tmpHtml, html);
  win.webContents.setZoomFactor(1);
  await win.loadFile(tmpHtml);
  await win.webContents.executeJavaScript("(async()=>{try{await document.fonts.ready}catch(e){}return true})()");

  // Font A: `cols` characters fill the printhead and a line is two characters
  // tall. A line wider than the paper (a Chinese character is two columns wide
  // on screen, one in the layout) is squeezed to fit rather than cut off.
  const rects = await win.webContents.executeJavaScript(`(() => {
    const W = ${W};
    const inner = ${inner};
    const probe = document.getElementById('probe');
    const size = 20 * inner / probe.getBoundingClientRect().width;
    const ch = inner / ${cols};
    document.querySelectorAll('.run').forEach((r) => { r.style.fontSize = size + 'px'; r.style.lineHeight = (ch * 2) + 'px'; });
    document.querySelectorAll('.pl').forEach((el) => {
      if (el.classList.contains('h2')) el.style.lineHeight = (ch * 4) + 'px';
      if (el.scrollWidth > inner) el.style.transform = 'scaleX(' + (inner / el.scrollWidth) + ')';
    });
    void document.body.offsetHeight;
    return Array.from(document.querySelectorAll('.run')).map((r) => {
      const b = r.getBoundingClientRect();
      return { x: Math.floor(b.left), y: Math.floor(b.top + window.scrollY), width: W, height: Math.ceil(b.height) };
    });
  })()`);
  const docH = rects.reduce((m, r) => Math.max(m, r.y + r.height), 0);
  win.setContentSize(W + 20, Math.min(docH + 20, 6000));
  await waitForPaint(win);

  const bands = [];
  for (const r of rects) {
    if (!r.height) { bands.push(Buffer.alloc(0)); continue; }
    let img = await win.webContents.capturePage({ x: r.x, y: r.y, width: r.width, height: r.height });
    if (img.getSize().width !== W) img = img.resize({ width: W, quality: "best" });
    const size = img.getSize();
    bands.push(Buffer.concat([Buffer.from("\x1b\x61\x00", "latin1"), rasterBands(img.toBitmap(), size.width, size.height)]));
  }

  let runIdx = 0;
  const out = [Buffer.from([0x1b, 0x40])];
  parts.forEach((p) => {
    if (p.run) { out.push(bands[runIdx++]); return; }
    // physToEscPos opens with ESC @, which only resets the style: harmless here.
    out.push(Buffer.from(BillTemplate.physToEscPos([p.line], { paper, cut: cutBytes() }), "latin1"));
  });
  return Buffer.concat(out);
}

// A payload that carries the account's layout keeps this PC's copy current even
// when the API is unreachable — but never over a local save still waiting to be
// pushed, which is the newer of the two.
function adoptPayloadTemplate(raw, doc) {
  const k = DOC_KEYS[docOf(doc)];
  if (raw === undefined || raw === null || printConfig[k.pending]) return;
  const tpl = BillTemplate.normalizeTemplate(raw);
  if (!tpl) return;
  if (JSON.stringify(tpl) === JSON.stringify(printConfig[k.template])) return;
  log.info(`${docOf(doc) === "kot" ? "KOT" : "Bill"} layout updated from the print payload`);
  savePrintConfig({ ...printConfig, [k.template]: tpl, [k.pending]: false, [k.syncedAt]: new Date().toISOString() });
  broadcastTemplateStatus();
}

// The kitchen ticket's sample order (no store details: the KOT payload has none).
function sampleKot(kind) {
  const base = BillTemplate.SAMPLE_KOTS[kind] || BillTemplate.SAMPLE_KOTS.delivery;
  return Object.assign({}, base, { generated_at: "" });
}

// --- images on the ESC/POS path ---
// A logo used to force the whole bill onto the raster path. With a layout the
// picture is fetched once, scaled to its share of the printhead, thresholded to
// one bit and sent inline as GS v 0 between the text lines.
const imageCache = new Map(); // url -> { img, at }
const IMAGE_CACHE_MS = 10 * 60 * 1000;

function fetchBytes(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = net.request({ url, method: "GET" });
      const timer = setTimeout(() => { try { req.abort(); } catch (e) { /* gone */ } finish(null); }, timeoutMs);
      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { clearTimeout(timer); finish(res.statusCode >= 200 && res.statusCode < 300 ? Buffer.concat(chunks) : null); });
        res.on("error", () => { clearTimeout(timer); finish(null); });
      });
      req.on("error", () => { clearTimeout(timer); finish(null); });
      req.end();
    } catch (e) {
      finish(null);
    }
  });
}

async function loadImageForPrint(src) {
  if (!src) return null;
  if (/^data:image\//i.test(src)) {
    const img = nativeImage.createFromDataURL(src);
    return img.isEmpty() ? null : img;
  }
  if (!/^https?:\/\//i.test(src)) return null;
  const hit = imageCache.get(src);
  if (hit && Date.now() - hit.at < IMAGE_CACHE_MS) return hit.img;
  const bytes = await fetchBytes(src);
  if (!bytes) { log.warn(`Bill layout: could not fetch image ${src}`); return null; }
  const img = nativeImage.createFromBuffer(bytes);
  if (img.isEmpty()) { log.warn(`Bill layout: not an image: ${src}`); return null; }
  imageCache.set(src, { img, at: Date.now() });
  return img;
}

async function resolveImageLines(lines) {
  for (const line of lines) {
    if (line.t !== "image") continue;
    const img = await loadImageForPrint(line.src);
    if (!img) continue; // the engine skips an image with no bytes rather than failing the print
    const pct = Number(line.width) || 50;
    const targetW = Math.max(8, Math.min(RASTER_WIDTH, Math.round((RASTER_WIDTH * pct) / 100 / 8) * 8));
    const sized = img.getSize().width === targetW ? img : img.resize({ width: targetW, quality: "best" });
    const size = sized.getSize();
    if (!size.width || !size.height) continue;
    line.raster = rasterBands(sized.toBitmap(), size.width, size.height).toString("latin1");
  }
}

// 1-bit black/white PNG data URL at `width` pixels — what the printer will
// actually draw, so the designer's preview and the image stored in the layout
// are honest about how a logo comes out on thermal paper.
function toMonoPngDataUrl(img, width) {
  const sized = img.resize({ width, quality: "best" });
  const size = sized.getSize();
  const bgra = sized.toBitmap();
  const out = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    const lum = 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2] + (255 - bgra[i + 3]);
    const v = lum < RASTER_THRESHOLD ? 0 : 255;
    out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(out, { width: size.width, height: size.height }).toDataURL();
}

// --- account sync ---
// Talks to cravings.live with the cookies the app window is signed in with, so
// the server knows which partner this is (and, for the Menuthere team, which
// partner they are signed in as). No Hasura credentials live in the app.
function apiRequest(method, apiPath, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const req = net.request({ method, url: apiBase() + apiPath, useSessionCookies: true });
      req.setHeader("Accept", "application/json");
      if (body !== undefined) req.setHeader("Content-Type", "application/json");
      const timer = setTimeout(() => { try { req.abort(); } catch (e) { /* gone */ } finish({ ok: false, error: "timeout" }); }, timeoutMs);
      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300 && !!json, status: res.statusCode, json });
        });
        res.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
      });
      req.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

const templateSync = { state: "idle", message: "", at: null };
let syncInFlight = null;

function setSyncState(state, message) {
  templateSync.state = state;
  templateSync.message = message || "";
  templateSync.at = new Date().toISOString();
  log.info(`Bill layout sync: ${state}${message ? " - " + message : ""}`);
}

function templateStatus() {
  const tpl = printConfig.billTemplate;
  const ktpl = printConfig.kotTemplate;
  return {
    storeName: printConfig.billStore ? printConfig.billStore.store_name : null,
    kot: {
      hasTemplate: !!ktpl,
      blocks: ktpl ? ktpl.blocks.length : 0,
      pending: !!printConfig.kotTemplatePending,
      syncedAt: printConfig.kotTemplateSyncedAt,
      updatedAt: printConfig.kotTemplateUpdatedAt,
      hasLast: !!lastKotPayload,
    },
    hasTemplate: !!tpl,
    blocks: tpl ? tpl.blocks.length : 0,
    useCustom: !!printConfig.billTemplateUseCustom,
    pending: !!printConfig.billTemplatePending,
    syncedAt: printConfig.billTemplateSyncedAt,
    updatedAt: printConfig.billTemplateUpdatedAt,
    logoUrl: printConfig.billLogoUrl,
    sync: Object.assign({}, templateSync),
    activeType: printConfig.activeType,
    printMode: printConfig.printMode,
    hasLastBill: !!lastBillPayload,
  };
}

function broadcastTemplateStatus() {
  const status = templateStatus();
  [settingsWindow, designerWindow].forEach((w) => {
    try { if (w && !w.isDestroyed()) w.webContents.send("bill-template:status", status); } catch (e) { /* closing */ }
  });
}

function describeSyncFailure(r) {
  if (r.status === 401 || r.status === 403) return ["signed-out", "Sign in to the dashboard in the app window, then save again"];
  if (r.status === 404) return ["unavailable", "Bill-layout sync is not available on the server"];
  if (r.status && r.status >= 500) return ["offline", `Server error ${r.status}`];
  if (r.status) return ["offline", `Unexpected reply (${r.status})`];
  return ["offline", r.error === "timeout" ? "No reply from the server" : (r.error || "No connection")];
}

async function pushBillTemplate() {
  // Whatever this PC has goes up: the bill layout, the KOT layout, or both.
  const body = {};
  if (printConfig.billTemplate) body.template = printConfig.billTemplate;
  if (printConfig.kotTemplate) body.kotTemplate = printConfig.kotTemplate;
  if (!Object.keys(body).length) { setSyncState("synced", "Nothing to send"); return true; }
  const r = await apiRequest("PUT", BILL_TEMPLATE_API, body);
  if (r.ok && r.json.ok) {
    const now = new Date().toISOString();
    const stamp = typeof r.json.updatedAt === "string" ? r.json.updatedAt : null;
    savePrintConfig(Object.assign({}, printConfig,
      body.template ? { billTemplatePending: false, billTemplateSyncedAt: now, billTemplateUpdatedAt: stamp || printConfig.billTemplateUpdatedAt } : {},
      body.kotTemplate ? { kotTemplatePending: false, kotTemplateSyncedAt: now, kotTemplateUpdatedAt: stamp || printConfig.kotTemplateUpdatedAt } : {},
      r.json.logoUrl !== undefined ? { billLogoUrl: r.json.logoUrl || null } : {},
      cleanStore(r.json.store) ? { billStore: cleanStore(r.json.store) } : {}));
    setSyncState("synced", "Saved to your account");
    return true;
  }
  const [state, message] = describeSyncFailure(r);
  setSyncState(state, message);
  return false;
}

async function pullBillTemplate() {
  const r = await apiRequest("GET", BILL_TEMPLATE_API);
  if (!(r.ok && r.json.ok)) {
    const [state, message] = describeSyncFailure(r);
    setSyncState(state, message);
    return false;
  }
  const updates = {};
  if (r.json.logoUrl !== undefined) updates.billLogoUrl = r.json.logoUrl || null;
  if (cleanStore(r.json.store)) updates.billStore = cleanStore(r.json.store);
  const now = new Date().toISOString();
  const stamp = typeof r.json.updatedAt === "string" ? r.json.updatedAt : null;
  const tpl = BillTemplate.normalizeTemplate(r.json.template);
  if (tpl) {
    updates.billTemplate = tpl;
    updates.billTemplatePending = false;
    updates.billTemplateSyncedAt = now;
    updates.billTemplateUpdatedAt = stamp || printConfig.billTemplateUpdatedAt;
  }
  const ktpl = BillTemplate.normalizeTemplate(r.json.kotTemplate);
  if (ktpl) {
    updates.kotTemplate = ktpl;
    updates.kotTemplatePending = false;
    updates.kotTemplateSyncedAt = now;
    updates.kotTemplateUpdatedAt = stamp || printConfig.kotTemplateUpdatedAt;
  }
  savePrintConfig(Object.assign({}, printConfig, updates));
  // This PC has a layout the account does not (saved before sync existed, or
  // while offline): send it up rather than throw it away.
  if ((printConfig.billTemplate && !tpl) || (printConfig.kotTemplate && !ktpl)) return pushBillTemplate();
  setSyncState("synced", tpl || ktpl ? "Up to date with your account" : "No custom layout yet");
  return true;
}

// A local save still waiting goes up; otherwise the account copy comes down.
// One sync at a time; callers get the same promise while one is running.
function syncBillTemplate(reason) {
  if (syncInFlight) return syncInFlight;
  setSyncState("syncing", reason || "");
  broadcastTemplateStatus();
  syncInFlight = (async () => {
    try {
      const pending = (printConfig.billTemplatePending && printConfig.billTemplate) || (printConfig.kotTemplatePending && printConfig.kotTemplate);
      if (pending) await pushBillTemplate();
      else await pullBillTemplate();
    } catch (e) {
      setSyncState("offline", e.message);
    } finally {
      syncInFlight = null;
      broadcastTemplateStatus();
    }
    return templateStatus();
  })();
  return syncInFlight;
}

// --- BILL LAYOUT WINDOW (designer.html) ---
// 1.6.10: the bill / KOT layout is designed in the dashboard (Settings →
// Printing → Custom layout, the same designer moved to the web), so it is the
// one place for every PC and phone. What is left opening it (Ctrl+Shift+L)
// points there instead; the window below is no longer reachable.
function openDesignerWindow() {
  dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: "info",
    title: "Bill layout",
    message: "Bill and KOT layouts are designed in your dashboard now",
    detail: "Open Settings → Printing → Custom layout in the dashboard. The layout you save there prints on every PC and phone.",
  }).catch(() => {});
}

// eslint-disable-next-line no-unused-vars
function openDesignerWindowLegacy(doc) {
  doc = docOf(doc);
  if (designerWindow && !designerWindow.isDestroyed()) {
    designerWindow.show();
    designerWindow.focus();
    try { designerWindow.webContents.send("designer:doc", doc); } catch (e) { /* closing */ }
    return;
  }
  designerWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: "Bill Layout",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "designer-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  designerWindow.setMenuBarVisibility(false);
  designerWindow.loadFile(path.join(__dirname, "designer.html"), { query: { doc } });
  designerWindow.on("closed", () => { designerWindow = null; });
  // A fresh copy from the account whenever the window opens (a local save still
  // waiting goes up first), so two PCs and the Menuthere team see one layout.
  syncBillTemplate("window opened").catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Menuthere",
    frame: true,
    icon: path.join(__dirname, "build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  buildAppMenu();

  // The page names the window; add the app version so support can read it
  // off a screenshot.
  mainWindow.setTitle(`Menuthere · v${app.getVersion()}`);
  mainWindow.on("page-title-updated", (e, title) => {
    e.preventDefault();
    mainWindow.setTitle(`${title} · v${app.getVersion()}`);
  });

  mainWindow.loadURL("https://menuthere.com/");

  // Restore the saved mute state, and re-apply after every navigation/reload so
  // the alarm can't come back unmuted when the dashboard reloads.
  applyOrderSoundMute();
  mainWindow.webContents.on("did-finish-load", applyOrderSoundMute);
  // The dashboard's Printers tab logs this after saving a change: fetch it now.
  mainWindow.webContents.on("console-message", (_e, _level, message) => {
    if (message === "PRINT DEVICES CHANGED") reportDevice(true);
  });

  // --- BACKGROUND PRINTING HANDLER ---
  // Runs the whole hidden-window print pipeline for one /bill/ or /kot/ URL.
  const startPrintJob = (url) => {
      console.log(`Intercepted URL for printing: ${url}`);
      // The dashboard's latest printer choice (copies, printers) before this
      // job is sent: it lands while the page loads, so it costs no time.
      reportDevice(true);
      const jobT0 = Date.now();
      const since = () => `${Date.now() - jobT0}ms`;

      const backgroundWindow = new BrowserWindow({
        show: false,
        width: RASTER_WIDTH + 44,
        height: 1200,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          backgroundThrottling: false,
        },
        parent: mainWindow,
      });

      // Lay out at RASTER_SRC_WIDTH; captureReceiptRaster zooms it to the printhead
      // width and downscales the native capture for crisp output.
      // Build the query properly. A naive `${url}?print=false` breaks if the URL
      // already carries a query (`...?x=1?print=false`) — the page then never sees
      // print=false, calls window.print(), and the user gets a printer dialog
      // instead of a silent thermal print.
      let printUrl;
      try {
        const u = new URL(url);
        u.searchParams.set("print", "false");
        u.searchParams.set("w", `${RASTER_SRC_WIDTH}px`);
        printUrl = u.toString();
      } catch {
        const sep = url.includes("?") ? "&" : "?";
        printUrl = `${url}${sep}print=false&w=${RASTER_SRC_WIDTH}px`;
      }
      backgroundWindow.loadURL(printUrl);
      backgroundWindow.webContents.once("did-finish-load", () =>
        log.info(`[timing] page loaded @${since()}`));

      // Capture console messages -> build ESC/POS text OR a raster image
      let printHandled = false;
      backgroundWindow.webContents.on('console-message', async (event, level, message, line, sourceId) => {
          if (printHandled) return;

          const kotPrefix = "KOT Contents JSON:";
          const billPrefix = "Bill Contents JSON:";
          let jsonStr = null;
          let isBill = false;
          if (message.startsWith(billPrefix)) {
              jsonStr = message.substring(billPrefix.length).trim();
              isBill = true;
          } else if (message.startsWith(kotPrefix)) {
              jsonStr = message.substring(kotPrefix.length).trim();
              isBill = false;
          } else {
              return; // not a print payload
          }

          printHandled = true; // guard against duplicate console logs (double-print)
          let orderData = null;
          let escPosBuffer = null;
          let jobName = "print_job";

          try {
              orderData = JSON.parse(jsonStr);
              jobName = (isBill ? "bill_" : "kot_") + orderData.id;
              log.info(`Received ${isBill ? "Bill" : "KOT"} JSON:`, orderData.id, `[timing] payload@${since()}`);
              if (isBill) {
                lastBillPayload = orderData;
                adoptPayloadTemplate(orderData.bill_template, "bill");
                rememberStoreFromBill(orderData);
              } else {
                lastKotPayload = orderData;
                adoptPayloadTemplate(orderData.kot_template, "kot");
              }

              // Layout + Full Arabic are now chosen in the web dashboard and travel in
              // the print payload. A boolean `full_arabic` in the payload means this is a
              // current web build that ALREADY rendered the chosen layout + Arabic on the
              // live page — so we just capture that page. Older builds omit these fields;
              // we then fall back to the locally-cached print-config and render locally.
              const webRendered = typeof orderData.full_arabic === "boolean";
              const fullArabic = webRendered ? orderData.full_arabic : printConfig.fullArabic;
              const layout = isValidBillLayout(orderData.bill_layout) ? orderData.bill_layout : printConfig.billLayout;

              // A Star TSP100 / TSP143 has no fonts: it always prints raster.
              if (printConfig.printMode === "escpos" && printConfig.printerType !== "star") {
                  // Raw ESC/POS text: the printer's built-in font, DEFAULT layout only.
                  // Custom layouts, Arabic and logos are image-only, so warn loudly
                  // rather than silently dropping them from the receipt.
                  if (isBill && isCustomBillLayout(layout)) {
                      log.warn(`ESC/POS mode: ignoring '${layout}' bill layout (raster-only) - printing the default layout`);
                  }
                  if (fullArabic || receiptHasUnprintable(orderData, isBill)) {
                      log.warn("ESC/POS mode: non-ASCII text (e.g. Arabic) cannot be rendered by the printer font and will be dropped - switch to Raster to print it");
                  }
                  const customLayout = isBill ? activeBillTemplate(orderData) : activeKotTemplate(orderData);
                  if (isBill && orderData.bill_logo_url && !customLayout) {
                      log.warn("ESC/POS mode: bill logo skipped (images need Raster mode, or a custom bill layout with a logo block)");
                  }
                  log.info(`Using ESC/POS text print (${customLayout ? "custom " + (isBill ? "bill" : "KOT") + " layout" : "default layout"})`);
                  escPosBuffer = isBill
                      ? await buildEscPosBill(orderData)
                      : await buildEscPosKot(orderData);
              } else if (isBill ? activeBillTemplate(orderData) : activeKotTemplate(orderData)) {
                  // Raster mode + this PC prints the custom layout: draw that layout.
                  const tpl = isBill ? activeBillTemplate(orderData) : activeKotTemplate(orderData);
                  log.info(`Using custom ${isBill ? "bill" : "KOT"} layout raster print`);
                  try {
                      escPosBuffer = await buildTemplateRaster(tpl, orderData, backgroundWindow);
                  } catch (e) {
                      // A broken layout must never cost a partner a bill.
                      log.error("Custom layout raster failed; printing the page instead", e);
                      // A picture of the page, not ESC/POS text: a Star TSP100 prints
                      // no text, and an ESC/POS printer prints the page as well.
                      escPosBuffer = await captureReceiptRaster(backgroundWindow, false, isBill ? orderData.delivery_boy : null);
                  }
              } else if (isBill && isCustomBillLayout(layout)) {
                  if (webRendered) {
                      // The live /bill page already rendered this layout — capture it as-is.
                      log.info(`Using ${layout} bill layout raster print (web-rendered)`);
                      escPosBuffer = await captureReceiptRaster(backgroundWindow, false, isBill ? orderData.delivery_boy : null);
                  } else {
                      // Legacy web build: render the layout HTML from the order data,
                      // load it into the hidden window, raster.
                      log.info(`Using ${layout} bill layout raster print (local)`);
                      const html = await buildBillLayoutHtml(orderData, RASTER_SRC_WIDTH, fullArabic, layout);
                      const tmpHtml = app.isPackaged
                        ? path.join(process.resourcesPath, "temp_invoice.html")
                        : path.join(__dirname, "temp_invoice.html");
                      fs.writeFileSync(tmpHtml, html);
                      await backgroundWindow.loadFile(tmpHtml);
                      escPosBuffer = await captureReceiptRaster(backgroundWindow, false, isBill ? orderData.delivery_boy : null);
                  }
              } else if (fullArabic || receiptHasUnprintable(orderData, isBill) || (isBill && orderData.bill_logo_url)) {
                  // Non-ASCII text (Arabic item names / Full Arabic labels) OR a bill logo
                  // (an image) -> render the page to a raster; the printer can't do either
                  // as ESC/POS text. Current builds already rendered Arabic; only legacy
                  // builds need injection.
                  log.info(`Using raster image print (fullArabic=${fullArabic}, logo=${!!orderData.bill_logo_url}, webRendered=${webRendered})`);
                  escPosBuffer = await captureReceiptRaster(backgroundWindow, fullArabic && !webRendered, isBill ? orderData.delivery_boy : null);
              } else {
                  // Raster mode with nothing special on the receipt: still print as an
                  // image so "Raster" means raster — what you see on /bill is what the
                  // printer produces. ESC/POS text is reached only via printMode.
                  log.info("Using raster image print (raster mode)");
                  escPosBuffer = await captureReceiptRaster(backgroundWindow, false, isBill ? orderData.delivery_boy : null);
              }
              escPosBuffer = forPrinterType(escPosBuffer);
          } catch (e) {
              log.error("Error building print payload", e);
              printHandled = false; // allow a retry on a later log
              return;
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
                  
                  const label = isBill ? "bill" : "KOT";
                  const targets = printersFor(isBill);
                  log.info(`Printing ${label} to: ${describeTargets(targets)}`);

                  sendToPrinters(exePath, filePath, targets, label).then(() => {
                      log.info(`${label} print finished`, `[timing] TOTAL job=${since()}`);

                      const where = describeTargets(targets);
                      mainWindow.webContents.send("print-status", {
                        success: true,
                        message: `${isBill ? "Bill" : "KOT"} sent to ${where} 🖨️`,
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

  };

  const isPrintUrl = (u) =>
    typeof u === "string" && (u.includes("/bill/") || u.includes("/kot/"));
  // window.open("", "_blank") — a tab claimed before its URL is known.
  const isClaimedBlank = (u) => !u || u === "about:blank";

  // The web app's src/lib/printOrder.ts claims its tabs SYNCHRONOUSLY inside the
  // click (otherwise the popup is blocked after an await) and only navigates them
  // to /bill|/kot afterwards. That means the URL is not known in the open handler,
  // so we let the window through but keep it hidden and take it over the moment it
  // heads for a print route — before the page can fire its own window.print().
  const watchClaimedPrintWindow = (child) => {
    let taken = false;
    // Was the app in front when this tab was claimed? The claim happens inside
    // the user's click, so normally yes — and that is what we restore to after
    // the popup is torn down.
    let appHadFocus = false;
    try {
      appHadFocus = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
    } catch { /* ignore */ }

    // These tabs are a printing implementation detail and must never be seen.
    // `show:false` in overrideBrowserWindowOptions is not always honoured for
    // window.open-created windows, which is how the "Preparing bill…" placeholder
    // flashed up as a popup — so hide it explicitly, and keep it hidden.
    const keepHidden = () => {
      try { if (!child.isDestroyed() && child.isVisible()) child.hide(); } catch { /* gone */ }
    };
    log.info(`Claimed tab created (visible=${(() => { try { return child.isVisible(); } catch { return "?"; } })()})`);
    keepHidden();
    child.on("show", keepHidden);
    child.once("ready-to-show", keepHidden);

    const takeOver = (event, navUrl) => {
      if (taken || child.isDestroyed()) return;
      if (!isPrintUrl(navUrl)) {
        // about:blank is the claim itself, not a destination — the tab is opened
        // blank and navigated a moment later. Showing on THAT is what flashed a
        // "Preparing bill…" popup on screen during every print.
        if (isClaimedBlank(navUrl)) return;
        // A genuine non-print popup: reveal it rather than strand it invisible.
        log.info(`Claimed tab went to a non-print URL (${navUrl}); showing it`);
        if (!child.isVisible()) child.show();
        return;
      }
      taken = true;
      if (event && !event.defaultPrevented) event.preventDefault();
      log.info(`Claimed print window heading to ${navUrl}; taking over`);
      startPrintJob(navUrl);

      // Tear the claimed window down on a LATER TICK. Stopping/closing a window
      // from inside its own webContents event is a well-known way to crash
      // Electron — the navigation is still being dispatched on that very
      // webContents. Deferring gets us out of that stack first.
      setImmediate(() => {
        try {
          if (!child.isDestroyed()) {
            child.webContents.stop();
            child.close();
          }
        } catch { /* already gone */ }
        // Closing a popup can hand focus to whatever is behind us, which looks
        // like the app "going to the background". Put the dashboard back in
        // front — but only if the app still owns focus, so we never yank the
        // user out of another app they deliberately switched to.
        try {
          if (
            mainWindow &&
            !mainWindow.isDestroyed() &&
            !mainWindow.isFocused() &&
            !mainWindow.isMinimized() &&
            appHadFocus
          ) {
            mainWindow.show();
            mainWindow.focus();
          }
        } catch { /* window went away */ }
      });
    };

    child.webContents.on("will-navigate", takeOver);
    // Fallback: a location.replace() driven by the OPENER can reach the child
    // without a cancelable will-navigate, so stop it here instead.
    child.webContents.on("did-start-navigation", (event, navUrl, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) takeOver(null, navUrl);
    });

    // If it never navigates anywhere, don't strand a hidden window.
    const orphanTimer = setTimeout(() => {
      if (!taken && !child.isDestroyed() && !child.isVisible()) child.close();
    }, 20000);
    child.on("closed", () => clearTimeout(orphanTimer));
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    log.info(`window.open -> ${url || "(blank)"}`);
    if (isPrintUrl(url)) {
      startPrintJob(url);
      return { action: "deny" };
    }
    if (isClaimedBlank(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: false,
          parent: mainWindow,
          // These tabs exist only to be taken over for printing. Keep them out
          // of the taskbar and unable to take focus, so clicking Print never
          // pulls the dashboard out from under the user.
          focusable: false,
          skipTaskbar: true,
        },
      };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("did-create-window", (child, details) => {
    const childUrl = details && details.url;
    log.info(`child window created -> ${childUrl || "(blank)"}`);
    if (isClaimedBlank(childUrl)) watchClaimedPrintWindow(child);
  });

  // Ctrl+Shift+P opens Printer Settings, Ctrl+Shift+L the Bill Layout window
  // (both work even though the menu bar is hidden). Ctrl+Shift+B (Cmd+Shift+B
  // on a Mac) shows a URL bar to open another address in this window.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = (input.key || "").toLowerCase();
    if (input.control && input.shift && key === "p") openPrinterSettings();
    if (input.control && input.shift && key === "l") openDesignerWindow();
    if ((input.control || input.meta) && input.shift && key === "b") {
      event.preventDefault();
      if (input.type === "keyDown") toggleUrlBar();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- URL BAR (Ctrl+Shift+B) ---
// A bar over the top of the dashboard, filled with the current address: edit
// it and press Enter (or Go) to open that page here, Esc to close. Drawn in
// its own shadow DOM so the page's styles can't reach it. Only http(s)
// addresses; one typed without a scheme gets https://.
function toggleUrlBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`(() => {
    const ID = "__menuthere_url_bar";
    const old = document.getElementById(ID);
    if (old) { old.remove(); return; }
    const host = document.createElement("div");
    host.id = ID;
    host.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = \`
      <style>
        .bar { display:flex; gap:8px; align-items:center; padding:8px 10px; background:#18181b;
               box-shadow:0 2px 10px rgba(0,0,0,.3); font:13px -apple-system,"Segoe UI",sans-serif; }
        input { flex:1; min-width:0; height:32px; padding:0 10px; border:1px solid #3f3f46; border-radius:6px;
                background:#27272a; color:#fafafa; font:inherit; outline:none; }
        input:focus { border-color:#e84a1f; }
        button { height:32px; padding:0 12px; border:0; border-radius:6px; font:inherit; cursor:pointer; }
        .go { background:#e84a1f; color:#fff; }
        .x { background:#3f3f46; color:#fafafa; }
        .err { color:#fca5a5; white-space:nowrap; }
      </style>
      <div class="bar">
        <input type="text" spellcheck="false" autocomplete="off" aria-label="Address" />
        <span class="err" hidden>Enter an http(s) address</span>
        <button class="go" type="button">Go</button>
        <button class="x" type="button" aria-label="Close">Esc</button>
      </div>\`;
    const input = root.querySelector("input");
    const err = root.querySelector(".err");
    input.value = location.href;
    const close = () => host.remove();
    const go = () => {
      let v = input.value.trim();
      if (!v) return;
      if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(v)) v = "https://" + v;
      let url;
      try { url = new URL(v); } catch (e) { url = null; }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) { err.hidden = false; return; }
      close();
      location.href = url.href;
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); go(); }
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (err && !err.hidden && e.key !== "Enter") err.hidden = true;
    });
    root.querySelector(".go").addEventListener("click", go);
    root.querySelector(".x").addEventListener("click", close);
    document.documentElement.appendChild(host);
    input.focus();
    input.select();
  })()`, true).catch((e) => log.warn("URL bar failed:", e.message));
}

// --- PRINTER SETTINGS WINDOW + TRAY ---
let tray = null;

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 470,
    height: 740,
    title: "Printer Settings",
    resizable: true,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    parent: mainWindow || undefined,
    icon: path.join(__dirname, "build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

// --- NEW-ORDER ALARM MUTE ---
// The dashboard loops an alert tone until the order is accepted. It is played by
// the web page, so the shell silences it by muting the window's audio — that also
// covers any future sound the dashboard adds.
function applyOrderSoundMute() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setAudioMuted(!!printConfig.muteOrderSound);
  }
}

// Play the new-order alert on demand so a counter can check the speakers without
// waiting for a real order. Runs in the dashboard window itself, so it exercises
// the exact path the alarm uses — same page, same audio output, same mute state.
// Prefers the page's own Howl (what the alarm actually plays) and falls back to a
// plain Audio element if the dashboard isn't loaded yet.
function testOrderSound() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.warn("Test sound: app window not ready");
    return;
  }
  if (printConfig.muteOrderSound) {
    log.info("Test sound: skipped, sound is muted");
    mainWindow.webContents.send("print-status", {
      success: false,
      message: "Sound is muted — untick 'Mute new-order sound' first",
    });
    return;
  }

  const js = `(async () => {
    try {
      const H = window.Howler;
      const h = H && H._howls && H._howls.find(
        (x) => String(x._src || x._origSrc || "").indexOf("custom_sound") !== -1
      );
      if (h) { h.stop(); h.play(); setTimeout(() => h.stop(), 5000); return "howl"; }
      const a = new Audio("/audio/custom_sound.mp3");
      await a.play();
      setTimeout(() => { try { a.pause(); } catch (e) {} }, 5000);
      return "audio";
    } catch (e) { return "error: " + ((e && e.message) || e); }
  })()`;

  // userGesture=true: a real gesture lets Chromium resume a suspended Web Audio
  // context, which is what Howler plays through.
  mainWindow.webContents
    .executeJavaScript(js, true)
    .then((how) => {
      log.info(`Test sound: ${how}`);
      const ok = how === "howl" || how === "audio";
      mainWindow.webContents.send("print-status", {
        success: ok,
        message: ok ? "Playing test sound 🔊" : `Could not play sound (${how})`,
      });
    })
    .catch((e) => log.warn("Test sound failed:", e.message));
}

function setOrderSoundMuted(muted) {
  savePrintConfig({ ...printConfig, muteOrderSound: !!muted });
  applyOrderSoundMute();
  buildAppMenu();
  refreshTrayMenu();
  log.info(`New-order sound ${printConfig.muteOrderSound ? "MUTED" : "unmuted"}`);
}

// Rebuilt whenever the mute toggle flips so the checkbox reflects reality.
function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Printer",
      submenu: [
        { label: "Printer Settings…", accelerator: "CmdOrCtrl+Shift+P", click: () => openPrinterSettings() },
        { label: "Test Print", click: () => { printTestSlip().catch((e) => log.warn("Test print failed:", e.message)); } },
        { type: "separator" },
        { role: "reload" },
        { role: "quit" },
      ],
    },
    {
      label: "Sound",
      submenu: [
        { label: "Test sound", click: () => testOrderSound() },
        { type: "separator" },
        {
          label: "Mute new-order sound",
          type: "checkbox",
          checked: !!printConfig.muteOrderSound,
          click: (item) => setOrderSoundMuted(item.checked),
        },
      ],
    },
    { label: `v${app.getVersion()}`, enabled: false },
  ]));
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Printer Settings", click: () => openPrinterSettings() },
    { label: "Test sound", click: () => testOrderSound() },
    {
      label: "Mute new-order sound",
      type: "checkbox",
      checked: !!printConfig.muteOrderSound,
      click: (item) => setOrderSoundMuted(item.checked),
    },
    { label: "Show App", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "build/icon.png"));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip("Menuthere");
    refreshTrayMenu();
    tray.on("double-click", () => openPrinterSettings());
  } catch (e) {
    log.warn("Tray init failed (settings still available via Ctrl+Shift+P):", e.message);
  }
}

// --- Printer settings IPC (from settings.html via settings-preload.js) ---
ipcMain.handle("print-config:get", () => printConfig);
// Ask the Windows spooler directly. Chromium's print backend is the primary
// source, but it has been seen returning a short list (notably when queried
// before the backend has finished initialising), and a partner who cannot see
// their kitchen printer has no way to work around it. This is the second
// opinion; the two are merged.
function spoolerPrinterNames() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log.warn("Spooler printer enumeration failed:", err.message);
          return resolve([]);
        }
        // split on newlines without a regex literal - trim() handles any CR
        const rows = String(stdout || "").split(String.fromCharCode(10));
        resolve(rows.map((n) => n.trim()).filter(Boolean));
      }
    );
  });
}

// The machine's printer list: for the settings window, and reported to the
// dashboard's Settings → Printing → Printers.
ipcMain.handle("print-config:printers", () => listPrinters());

async function listPrinters() {
  const out = [];
  const seen = new Set();
  const add = (name, displayName, isDefault, source) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, displayName: displayName || name, isDefault: !!isDefault, source });
  };

  let error = null;
  try {
    const wc = (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) || null;
    const list = wc ? await wc.getPrintersAsync() : [];
    list.forEach((p) => add(p.name, p.displayName, p.isDefault, "chromium"));
  } catch (e) {
    error = e.message;
    log.warn("Could not list printers via Chromium:", e.message);
  }

  // Anything the spooler knows about that Chromium did not report.
  const fromSpooler = await spoolerPrinterNames();
  const before = out.length;
  fromSpooler.forEach((name) => add(name, name, false, "spooler"));
  if (out.length > before) {
    log.info(`Printer list: Chromium reported ${before}, spooler added ${out.length - before} more`);
  }

  log.info(`Printer list: ${out.length} printer(s) -> ${out.map((p) => p.name).join(", ") || "(none)"}`);
  return { printers: out, error };
}
ipcMain.handle("print-config:save", (_e, cfg) => savePrintConfig(cfg));
ipcMain.handle("print-config:test", async (_e, which) => {
  try {
    const out = await printTestSlip(which === "kot" ? "kot" : "bill");
    return { ok: true, message: String(out || "").trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.on("settings:close", () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

// --- Bill layout IPC (settings.html + designer.html) ---
ipcMain.handle("bill-template:get", (_e, args) => {
  const doc = docOf(args && args.doc);
  const sample = doc === "kot" ? sampleKot : sampleBill;
  return {
    doc,
    template: printConfig[DOC_KEYS[doc].template],
    status: templateStatus(),
    lastBill: doc === "kot" ? lastKotPayload : lastBillPayload,
    sample: sample("delivery"),
    samples: { delivery: sample("delivery"), takeaway: sample("takeaway"), dine_in: sample("dine_in") },
  };
});
ipcMain.handle("bill-template:status", () => templateStatus());
ipcMain.handle("bill-template:sync", () => syncBillTemplate("refresh"));
ipcMain.handle("bill-template:save", async (_e, raw, docArg) => {
  const k = DOC_KEYS[docOf(docArg)];
  const tpl = BillTemplate.normalizeTemplate(raw);
  if (!tpl) return { ok: false, error: "That layout could not be read", status: templateStatus() };
  // Local first — the layout is safe on this PC even if the push fails.
  savePrintConfig({ ...printConfig, [k.template]: tpl, [k.pending]: true, [k.updatedAt]: new Date().toISOString() });
  broadcastTemplateStatus();
  await syncBillTemplate("saved");
  return { ok: true, status: templateStatus() };
});
ipcMain.handle("bill-template:use-custom", (_e, on) => {
  savePrintConfig({ ...printConfig, billTemplateUseCustom: !!on });
  log.info(`Bill layout: ${on ? "using the customized bill on this PC" : "printing the built-in bill on this PC"}`);
  broadcastTemplateStatus();
  return templateStatus();
});
// Always the ESC/POS path: the layout only applies there, whatever the print
// mode is set to — the window says so when the mode is Raster.
ipcMain.handle("bill-template:test", async (_e, args) => {
  try {
    const doc = docOf(args && args.doc);
    const isKot = doc === "kot";
    const tpl = BillTemplate.normalizeTemplate(args && args.template)
      || printConfig[DOC_KEYS[doc].template]
      || (isKot ? BillTemplate.DEFAULT_KOT_TEMPLATE : BillTemplate.DEFAULT_TEMPLATE);
    const last = isKot ? lastKotPayload : lastBillPayload;
    const useLast = !!(args && args.which === "last" && last);
    const kind = args && BillTemplate.SAMPLE_BILLS[args.which] ? args.which : "delivery";
    const order = useLast ? last : (isKot ? sampleKot(kind) : sampleBill(kind));
    const out = await printTestSlip(isKot ? "kot" : "bill", { template: tpl, order, escpos: printConfig.printMode === "escpos" && printConfig.printerType !== "star" });
    return { ok: true, message: String(out || "").trim(), usedLastBill: useLast };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("bill-template:pick-image", async (_e, args) => {
  const res = await dialog.showOpenDialog(designerWindow && !designerWindow.isDestroyed() ? designerWindow : undefined, {
    title: "Choose an image for the bill",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const img = nativeImage.createFromPath(res.filePaths[0]);
  if (img.isEmpty()) return { ok: false, error: "That file is not an image" };
  const pct = Number(args && args.width) || 50;
  // Stored at the 80 mm printhead's share of the width (576 dots); a 58 mm
  // printer scales it down at print time. One bit per pixel keeps it small.
  const width = Math.max(8, Math.min(576, Math.round((576 * pct) / 100)));
  const dataUrl = toMonoPngDataUrl(img, width);
  if (dataUrl.length > 120000) return { ok: false, error: "That image is too detailed for a bill. Try a simpler, smaller logo." };
  return { ok: true, dataUrl, file: path.basename(res.filePaths[0]) };
});
// Preview of a remote image as the printer would draw it (fetched here so the
// window, a local file, never has to deal with cross-origin rules).
ipcMain.handle("bill-template:fetch-image", async (_e, url) => {
  const img = await loadImageForPrint(url);
  if (!img) return { ok: false };
  const w = img.getSize().width || 576;
  return { ok: true, dataUrl: toMonoPngDataUrl(img, Math.min(576, w)) };
});
ipcMain.on("designer:open", (_e, doc) => openDesignerWindow(doc));
ipcMain.on("designer:close", () => {
  if (designerWindow && !designerWindow.isDestroyed()) designerWindow.close();
});


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
  applyPaperProfile();
  createWindow();
  createTray();
  checkForUpdates();
  // Once the dashboard is up, so the notice sits on top of it.
  setTimeout(showRebrandNoticeOnce, 2500);
  // Pick up a layout the Menuthere team (or another PC) saved to the account.
  // Later than the window, so the dashboard's own load is not competing with it.
  setTimeout(() => syncBillTemplate("startup").catch(() => {}), 6000);
  // This PC and its printers on the dashboard; picks up printer changes made there.
  setTimeout(() => reportDevice(true), 9000);
  setInterval(() => reportDevice(false), 5 * 60 * 1000 + 1000);
  // Dev convenience: `electron . --designer` opens the Bill Layout window at once.
  if (process.argv.includes("--designer")) setTimeout(() => openDesignerWindow(), 1500);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
