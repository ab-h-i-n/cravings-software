// Standalone visual check for the UAE invoice (layout 3). Renders billInvoiceUae.js from a
// sample order through the same zoom+capture pipeline and saves a PNG.
//   node_modules/.bin/electron test-invoice-uae.js <rasterWidth> <scale> [ar]
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { buildUaeInvoiceHtml } = require("./billInvoiceUae");

const RASTER_WIDTH = parseInt(process.argv[2], 10) || 576;
const scale = parseFloat(process.argv[3]) || 1.6;
const fullArabic = process.argv[4] === "ar";
const srcWidth = Math.round(RASTER_WIDTH / scale);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors the reference receipt (BIN BAKHIT): FISH 1x7 + PARATA 3x1 = 10.00 incl. VAT,
// so before-VAT = 9.52 and VAT @ 5% = 0.48.
const sampleOrder = {
  id: "0000test0-0000-0000-0000-000000000000",
  display_id: 53054,
  created_at: "19/07/2026",
  time: "8:02 PM",
  store_name: "BIN BAKHIT RESTAURANT & CAFETERIA",
  address: "New Al Nahda, Al Wathba, Abu Dhabi",
  phone: "02 583 7515",
  trn: "100005786700003",
  type: "Takeaway",
  payment_method: "cash",
  order_items: [
    { name: "FISH", price: 7, quantity: 1 },
    { name: "PARATA", price: 1, quantity: 3 },
  ],
  extra_charges: [],
  calculations: { gst_percentage: 5, gst_amount: 0.48, grand_total: 10.0, discount_amount: 0, subtotal: 10.0 },
  currency: "AED",
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: RASTER_WIDTH + 44, height: 1600, webPreferences: { backgroundThrottling: false } });
  const html = await buildUaeInvoiceHtml(sampleOrder, srcWidth, fullArabic);
  const tmp = path.join(__dirname, "temp_invoice_uae.html");
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript("(async()=>{try{await document.fonts.ready}catch(e){}return true})()");
  await delay(300);
  await win.webContents.executeJavaScript(`(() => { const el = document.getElementById('printable-content'); if (el) el.style.zoom = String(${RASTER_WIDTH}/${srcWidth}); return true; })()`);
  await delay(400);
  const rect = await win.webContents.executeJavaScript(`(() => { const el = document.getElementById('printable-content')||document.body; const r = el.getBoundingClientRect(); return { x:Math.floor(r.left), y:Math.floor(r.top), width:Math.ceil(r.width), height:Math.ceil(r.height) }; })()`);
  const zoom = RASTER_WIDTH / srcWidth;
  const zoomed = Math.abs(rect.width - RASTER_WIDTH) < Math.abs(rect.width - srcWidth);
  const visW = zoomed ? rect.width : Math.round(rect.width * zoom);
  const visH = zoomed ? rect.height : Math.ceil(rect.height * zoom);
  win.setContentSize(visW + 60, Math.min(rect.y + visH + 30, 6000));
  await delay(300);
  let img = await win.webContents.capturePage({ x: rect.x, y: rect.y, width: visW, height: visH });
  if (img.getSize().width !== RASTER_WIDTH) img = img.resize({ width: RASTER_WIDTH, quality: "best" });
  fs.writeFileSync(path.join(__dirname, `temp_invoice_uae_${RASTER_WIDTH}.png`), img.toPNG());
  console.log("OK uae invoice PNG", JSON.stringify(img.getSize()));
  app.quit();
});
