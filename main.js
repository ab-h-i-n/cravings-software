const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");
const { execFile } = require("child_process");
const { arabicLabelScript } = require("./arabicLabels");
const { buildInvoiceHtml } = require("./billInvoice");
const { buildUaeInvoiceHtml } = require("./billInvoiceUae");

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
    const logPath = path.join(app.getPath("desktop"), "cravings-log.txt");
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
function checkForUpdates() {
  // The published releases are built for Windows 10+ (modern Electron), so a Win7/8
  // machine must stay on its legacy build — auto-updating would replace it with a
  // binary that cannot start. Those machines are updated by re-running the installer.
  if (IS_LEGACY_WINDOWS) {
    log.info("Legacy Windows detected; skipping auto-update (legacy build is updated manually).");
    return;
  }

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

// Characters per line for the ESC/POS TEXT path. Font A glyphs are 12 dots wide,
// so a 58mm head (384 dots) fits 32 columns and an 80mm head (576) fits 48. This
// used to be hardcoded to 48, which made every line on a 58mm printer overflow and
// wrap. Derived from the active printer profile so text matches the paper.
function escposCharsPerLine() {
  return printConfig && printConfig.activeType === "58mm" ? 32 : 48;
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
  
  // 3. Table Name / Number
  buffer += ALIGN_CENTER;
  buffer += BOLD_ON;
  buffer += textLine(order.table_name || (order.table_number ? `Table ${order.table_number}` : "N/A"));
  buffer += BOLD_OFF;
  buffer += textLine("-".repeat(WIDTH));

  // 4. Order Info
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
      buffer += textLine(bill.address);
  }
  if (bill.phone) buffer += textLine(`Tel: ${bill.phone}`);
  
  buffer += textLine("-".repeat(WIDTH));
  
  // 3. Table Name / Number
  buffer += ALIGN_CENTER;
  buffer += BOLD_ON;
  buffer += textLine(bill.table_name || (bill.table_number ? `Table ${bill.table_number}` : "N/A"));
  buffer += BOLD_OFF;
  buffer += textLine("-".repeat(WIDTH));

  // 4. Bill Info
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
          const left = replaceSpecialChars(`${item.quantity} x ${item.name}`);
          // Wrap the name ourselves so it breaks at spaces; the amount is
          // right-aligned on the LAST line rather than pushed onto its own.
          const lines = escposWrap(left, Math.max(1, WIDTH - itemTotal.length - 1));
          lines.forEach((ln, i) => {
              buffer += (i === lines.length - 1) ? pair(ln, itemTotal) : textLine(ln);
          });
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
    buffer += textLine("Powered By Cravings");
  }
  
  // 8. Cut
  buffer += LF + LF + LF;
  buffer += CUT_FULL;
  
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
  // How receipts are sent to the printer:
  //   "raster" (default) — render the page to a GS v 0 bitmap. Handles Arabic,
  //                        logos and the invoice/uae bill layouts.
  //   "escpos"           — raw ESC/POS text in the printer's own font. Faster,
  //                        but DEFAULT layout only: no custom layouts, no Arabic,
  //                        no logos (the printer simply cannot render them).
  printMode: "raster",
  profiles: {
    "58mm": { rasterWidth: 384, scale: 1.6 },
    "80mm": { rasterWidth: 576, scale: 1.6 },
  },
};
let printConfig = JSON.parse(JSON.stringify(DEFAULT_PRINT_CONFIG));

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
      if (parsed.printMode === "raster" || parsed.printMode === "escpos") cfg.printMode = parsed.printMode;
      if (isValidBillLayout(parsed.billLayout)) cfg.billLayout = parsed.billLayout;
    } else {
      // legacy formats: { paperWidthMM: 58 } or { rasterWidth: N }
      if (parsed.paperWidthMM === 58) cfg.activeType = "58mm";
      else if (parsed.paperWidthMM === 80) cfg.activeType = "80mm";
      if (Number(parsed.rasterWidth) > 0) cfg.profiles[cfg.activeType].rasterWidth = clampWidth(parsed.rasterWidth);
    }
    log.info(`Print config loaded: ${JSON.stringify(cfg)}`);
  } catch (e) {
    // Say WHY: this used to be silent, so a corrupt file looked like the
    // calibration had reset itself for no reason.
    log.warn(`Could not read print-config.json (${e.message}); using defaults (80mm)`);
  }
  return cfg;
}

function applyPaperProfile() {
  printConfig = loadPrintConfig();
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
async function printTestSlip() {
  // ESC/POS mode: test the mode that will actually be used — raw text in the
  // printer's own font, default layout. No page render is involved at all.
  if (printConfig.printMode === "escpos") {
    log.info("Test print: ESC/POS text mode");
    const filename = "temp_printer_test.bin";
    const filePath = app.isPackaged ? path.join(process.resourcesPath, filename) : path.join(__dirname, filename);
    fs.writeFileSync(filePath, convertBillToEscPos(SAMPLE_ORDER));
    const exePath = app.isPackaged ? path.join(process.resourcesPath, "print-raw.exe") : path.join(__dirname, "print-raw.exe");
    return await new Promise((resolve, reject) => {
      execFile(exePath, [filePath], (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
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
    const escPosBuffer = await captureReceiptRaster(win, injectArabic);
    const filename = "temp_printer_test.bin";
    const filePath = app.isPackaged ? path.join(process.resourcesPath, filename) : path.join(__dirname, filename);
    fs.writeFileSync(filePath, escPosBuffer);
    const exePath = app.isPackaged ? path.join(process.resourcesPath, "print-raw.exe") : path.join(__dirname, "print-raw.exe");
    return await new Promise((resolve, reject) => {
      execFile(exePath, [filePath], (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  } finally {
    if (win && !win.isDestroyed()) win.close();
  }
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

// BGRA bitmap -> ESC/POS GS v 0 raster (split into horizontal bands).
function bitmapToRaster(bgra, w, h) {
  const bytesPerRow = Math.ceil(w / 8);
  const chunks = [Buffer.from([0x1b, 0x40])]; // ESC @ init
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
            const lum = 0.114 * bgra[idx] + 0.587 * bgra[idx + 1] + 0.299 * bgra[idx + 2];
            if (lum < RASTER_THRESHOLD) b |= 0x80 >> bit;
          }
        }
        data[y * bytesPerRow + bx] = b;
      }
    }
    chunks.push(header, data);
  }
  chunks.push(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00])); // feed + cut
  return Buffer.concat(chunks);
}

// Render the receipt page (already loaded in the hidden window) to a raster buffer.
// injectArabic: swap the static English labels to Arabic before capture. Only needed
// for OLD web builds that render the labels in English — current builds already render
// Arabic themselves (the dashboard's Full Arabic setting drives the /bill + /kot pages),
// and locally-built invoice HTML is already bilingual, so both pass injectArabic=false.
async function captureReceiptRaster(win, injectArabic = false) {
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
  await win.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('printable-content'); if (el) el.style.zoom = String(${RASTER_WIDTH} / ${RASTER_SRC_WIDTH}); return true; })()`
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

  buildAppMenu();

  mainWindow.loadURL("https://cravings.live/");

  // Restore the saved mute state, and re-apply after every navigation/reload so
  // the alarm can't come back unmuted when the dashboard reloads.
  applyOrderSoundMute();
  mainWindow.webContents.on("did-finish-load", applyOrderSoundMute);

  // --- BACKGROUND PRINTING HANDLER ---
  // Runs the whole hidden-window print pipeline for one /bill/ or /kot/ URL.
  const startPrintJob = (url) => {
      console.log(`Intercepted URL for printing: ${url}`);
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

              // Layout + Full Arabic are now chosen in the web dashboard and travel in
              // the print payload. A boolean `full_arabic` in the payload means this is a
              // current web build that ALREADY rendered the chosen layout + Arabic on the
              // live page — so we just capture that page. Older builds omit these fields;
              // we then fall back to the locally-cached print-config and render locally.
              const webRendered = typeof orderData.full_arabic === "boolean";
              const fullArabic = webRendered ? orderData.full_arabic : printConfig.fullArabic;
              const layout = isValidBillLayout(orderData.bill_layout) ? orderData.bill_layout : printConfig.billLayout;

              if (printConfig.printMode === "escpos") {
                  // Raw ESC/POS text: the printer's built-in font, DEFAULT layout only.
                  // Custom layouts, Arabic and logos are image-only, so warn loudly
                  // rather than silently dropping them from the receipt.
                  if (isBill && isCustomBillLayout(layout)) {
                      log.warn(`ESC/POS mode: ignoring '${layout}' bill layout (raster-only) - printing the default layout`);
                  }
                  if (fullArabic || receiptHasUnprintable(orderData, isBill)) {
                      log.warn("ESC/POS mode: non-ASCII text (e.g. Arabic) cannot be rendered by the printer font and will be dropped - switch to Raster to print it");
                  }
                  if (isBill && orderData.bill_logo_url) {
                      log.warn("ESC/POS mode: bill logo skipped (images need Raster mode)");
                  }
                  log.info("Using ESC/POS text print (default layout)");
                  escPosBuffer = isBill
                      ? convertBillToEscPos(orderData)
                      : convertOrderToEscPos(orderData);
              } else if (isBill && isCustomBillLayout(layout)) {
                  if (webRendered) {
                      // The live /bill page already rendered this layout — capture it as-is.
                      log.info(`Using ${layout} bill layout raster print (web-rendered)`);
                      escPosBuffer = await captureReceiptRaster(backgroundWindow, false);
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
                      escPosBuffer = await captureReceiptRaster(backgroundWindow, false);
                  }
              } else if (fullArabic || receiptHasUnprintable(orderData, isBill) || (isBill && orderData.bill_logo_url)) {
                  // Non-ASCII text (Arabic item names / Full Arabic labels) OR a bill logo
                  // (an image) -> render the page to a raster; the printer can't do either
                  // as ESC/POS text. Current builds already rendered Arabic; only legacy
                  // builds need injection.
                  log.info(`Using raster image print (fullArabic=${fullArabic}, logo=${!!orderData.bill_logo_url}, webRendered=${webRendered})`);
                  escPosBuffer = await captureReceiptRaster(backgroundWindow, fullArabic && !webRendered);
              } else {
                  // Raster mode with nothing special on the receipt: still print as an
                  // image so "Raster" means raster — what you see on /bill is what the
                  // printer produces. ESC/POS text is reached only via printMode.
                  log.info("Using raster image print (raster mode)");
                  escPosBuffer = await captureReceiptRaster(backgroundWindow, false);
              }
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
                  
                  execFile(exePath, [filePath], (err, stdout, stderr) => {
                      if (err) {
                        log.error("Raw printing error:", err);
                        return;
                      }
                      
                      log.info("Raw printing output:", stdout, `[timing] TOTAL job=${since()}`);
                      
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

  // Ctrl+Shift+P opens Printer Settings (works even though the menu bar is hidden).
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control && input.shift && (input.key || "").toLowerCase() === "p") {
      openSettingsWindow();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- PRINTER SETTINGS WINDOW + TRAY ---
let settingsWindow = null;
let tray = null;

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 470,
    height: 600,
    title: "Printer Settings",
    resizable: false,
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
        { label: "Printer Settings…", accelerator: "CmdOrCtrl+Shift+P", click: () => openSettingsWindow() },
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
  ]));
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Printer Settings", click: () => openSettingsWindow() },
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
    tray.setToolTip("Cravings.live");
    refreshTrayMenu();
    tray.on("double-click", () => openSettingsWindow());
  } catch (e) {
    log.warn("Tray init failed (settings still available via Ctrl+Shift+P):", e.message);
  }
}

// --- Printer settings IPC (from settings.html via settings-preload.js) ---
ipcMain.handle("print-config:get", () => printConfig);
ipcMain.handle("print-config:save", (_e, cfg) => savePrintConfig(cfg));
ipcMain.handle("print-config:test", async () => {
  try {
    const out = await printTestSlip();
    return { ok: true, message: String(out || "").trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.on("settings:close", () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
