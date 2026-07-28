// Standalone visual check for the invoice (layout 2). Renders billInvoice.js from a
// sample order through the same zoom+capture pipeline and saves a PNG.
//   node_modules/.bin/electron test-invoice.js <rasterWidth> <scale>
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { buildInvoiceHtml } = require("./billInvoice");

const RASTER_WIDTH = parseInt(process.argv[2], 10) || 576;
const scale = parseFloat(process.argv[3]) || 1.6;
const fullArabic = process.argv[4] === "ar";
const srcWidth = Math.round(RASTER_WIDTH / scale);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const sampleOrder = {
  id: "be5c7564-e388-46b9-aa80-c102c0a78c41",
  display_id: 4,
  created_at: "20/07/2026",
  time: "14:08",
  store_name: "Broast Al basha",
  address: "Jeddah, Al Fayha, Old Airport",
  phone: "0537555876 - 0500896589",
  gst_no: "311444943500003",
  trn: "310122393500003",
  type: "Takeaway",
  payment_method: "cash",
  customer_name: null,
  order_items: [
    { name: "Zinger Burger Meal برجر زنجر وجبة", price: 16, quantity: 1 },
    { name: "Chicken Burger برجر دجاج", price: 8, quantity: 2 },
  ],
  calculations: { gst_percentage: 15, gst_amount: 4.17, grand_total: 32.0, discount_amount: 0, subtotal: 32.0 },
  currency: "SAR",
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: RASTER_WIDTH + 44, height: 1600, webPreferences: { backgroundThrottling: false } });
  const html = await buildInvoiceHtml(sampleOrder, srcWidth, fullArabic);
  const tmp = path.join(__dirname, "temp_invoice.html");
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript("(async()=>{try{await document.fonts.ready}catch(e){}return true})()");
  await delay(300);
  const zoom = RASTER_WIDTH / srcWidth;
  await win.webContents.executeJavaScript(`(() => { const el = document.getElementById('printable-content'); if (el) el.style.zoom = String(${RASTER_WIDTH}/${srcWidth}); return true; })()`);
  await delay(400);
  const rect = await win.webContents.executeJavaScript(`(() => { const el = document.getElementById('printable-content')||document.body; const r = el.getBoundingClientRect(); return { x:Math.floor(r.left), y:Math.floor(r.top), width:Math.ceil(r.width), height:Math.ceil(r.height) }; })()`);
  const zoomed = Math.abs(rect.width - RASTER_WIDTH) < Math.abs(rect.width - srcWidth);
  const visW = zoomed ? rect.width : Math.round(rect.width * zoom);
  const visH = zoomed ? rect.height : Math.ceil(rect.height * zoom);
  win.setContentSize(visW + 60, Math.min(rect.y + visH + 30, 6000));
  await delay(300);
  let img = await win.webContents.capturePage({ x: rect.x, y: rect.y, width: visW, height: visH });
  if (img.getSize().width !== RASTER_WIDTH) img = img.resize({ width: RASTER_WIDTH, quality: "best" });
  fs.writeFileSync(path.join(__dirname, `temp_invoice_${RASTER_WIDTH}.png`), img.toPNG());
  console.log("OK invoice PNG", JSON.stringify(img.getSize()));
  app.quit();
});
