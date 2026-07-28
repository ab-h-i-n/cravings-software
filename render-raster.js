// Standalone validator for the production raster path.
//
// Loads a /bill/ or /kot/ page in a hidden Electron window (Chromium shapes the
// Arabic), captures the receipt element as a bitmap, converts it to an ESC/POS
// GS v 0 raster, and writes both a PNG preview and the .bin. This is the exact
// capture->raster logic that will go into main.js; here it runs in isolation so
// we can eyeball the PNG and print the .bin to the SR588 before touching the app.
//
// Usage:
//   node_modules/.bin/electron render-raster.js "<bill-or-kot-url>"

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { arabicLabelScript } = require("./arabicLabels");
const fullArabic = process.argv[5] === "ar"; // [5]="ar" -> translate labels to Arabic

const THRESHOLD = 160;
const BAND_ROWS = 128; // split GS v 0 into horizontal bands for small printer buffers
const SRC_RATIO = 240 / 384; // layout width as a fraction of the printhead (matches main.js)

// Args: [2] = printhead dot width (default 384=58mm; 576=80mm), [3] = "bill" | "kot".
// The receipt LAYS OUT at srcWidth (= width x ratio), then CSS `zoom` scales it up to
// RASTER_WIDTH. zoom re-rasterizes natively (crisp), unlike a bitmap upscale.
const RASTER_WIDTH = parseInt(process.argv[2], 10) || 384;
const mode = process.argv[3] || "bill";                 // "bill" | "kot" | "test"
const scaleArg = parseFloat(process.argv[4]);           // optional scale override
const srcWidth = scaleArg > 0 ? Math.max(1, Math.round(RASTER_WIDTH / scaleArg)) : Math.round(RASTER_WIDTH * SRC_RATIO);
const orderId = "be5c7564-e388-46b9-aa80-c102c0a78c41";
let url;
if (mode === "test") {
  const fileUrl = "file:///" + path.join(__dirname, "test-receipt.html").replace(/\\/g, "/");
  url = `${fileUrl}?w=${srcWidth}px&dots=${RASTER_WIDTH}&scale=${scaleArg || 1.6}`;
} else {
  const kind = mode === "kot" ? "kot" : "bill";
  url = `https://cravings.live/${kind}/${orderId}?print=false&w=${srcWidth}px`;
}
const tag = `w${RASTER_WIDTH}_s${srcWidth}`;
const outBin = path.join(__dirname, `temp_raster_render_${tag}.bin`);
const outPng = path.join(__dirname, `temp_raster_render_${tag}.png`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// BGRA bitmap -> ESC/POS GS v 0 raster (banded).
function bitmapToRaster(bgra, w, h) {
  const bytesPerRow = Math.ceil(w / 8);
  const chunks = [Buffer.from([0x1b, 0x40])]; // ESC @ init
  for (let y0 = 0; y0 < h; y0 += BAND_ROWS) {
    const bandH = Math.min(BAND_ROWS, h - y0);
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
            if (lum < THRESHOLD) b |= 0x80 >> bit;
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: RASTER_WIDTH + 44, // room for body margins so the receipt reaches 576
    height: 1200,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  try {
    win.webContents.setZoomFactor(1);
    await win.loadURL(url);
    // The bill/kot page fetches its order async and shows "Loading order details..."
    // until then. Wait for the actual receipt element to render before capturing.
    const ready = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const el = document.getElementById('printable-content');
        if (el && el.getBoundingClientRect().height > 60) return resolve(true);
        if (Date.now() - started > 20000) return resolve(false);
        setTimeout(check, 150);
      };
      check();
    })`);
    if (!ready) console.error("WARN: receipt element did not render in time");
    // then make sure the Arabic-capable font has finished loading
    await win.webContents.executeJavaScript(
      "(async()=>{try{await document.fonts.ready}catch(e){}return true})()"
    );
    if (fullArabic) {
      await win.webContents.executeJavaScript(arabicLabelScript());
    }
    // Scale the srcWidth layout up to RASTER_WIDTH via CSS zoom (native re-raster = crisp).
    await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('printable-content'); if (el) el.style.zoom = String(${RASTER_WIDTH} / ${srcWidth}); return true; })()`
    );
    await delay(450);

    const zoom = RASTER_WIDTH / srcWidth;
    const rect = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('printable-content') || document.body;
      const r = el.getBoundingClientRect();
      return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()`);
    // This Chromium reports getBoundingClientRect UNZOOMED, so the visual box is x zoom.
    // Detect which interpretation the runtime used and size the capture accordingly.
    const zoomed = Math.abs(rect.width - RASTER_WIDTH) < Math.abs(rect.width - srcWidth);
    const visW = zoomed ? rect.width : Math.round(rect.width * zoom);
    const visH = zoomed ? rect.height : Math.ceil(rect.height * zoom);

    win.setContentSize(visW + 60, Math.min(rect.y + visH + 30, 6000));
    await delay(300);

    let img = await win.webContents.capturePage({ x: rect.x, y: rect.y, width: visW, height: visH });
    console.error("pre-resize capture:", JSON.stringify(img.getSize()), "vis", visW, "x", visH);
    if (img.getSize().width !== RASTER_WIDTH) img = img.resize({ width: RASTER_WIDTH, quality: "best" });

    fs.writeFileSync(outPng, img.toPNG());
    const size = img.getSize();
    const bin = bitmapToRaster(img.toBitmap(), size.width, size.height);
    fs.writeFileSync(outBin, bin);
    console.log(`OK size=${size.width}x${size.height} bin=${bin.length} png=${outPng} bin=${outBin}`);
  } catch (e) {
    console.error("RENDER ERROR:", e && e.message ? e.message : e);
  } finally {
    app.quit();
  }
});
