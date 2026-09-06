// Proves that the default bill layout prints the same bill as the built-in
// convertBillToEscPos in main.js.
//
//   node check-template-default.js
//
// The legacy builder is lifted out of main.js by source (so main.js is never
// loaded, which would start the app). Both outputs are parsed back into
// "what the printer does" events — one per printed line with its alignment
// and style runs, plus QR / raster / cut events — and compared. Byte-level
// differences that print identically (a redundant ESC a, trailing spaces on a
// line) are deliberately ignored; anything visible is a failure.

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const BillTemplate = require("./billTemplate");

// ---------------------------------------------------------------- legacy
function loadLegacy(activeType) {
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const start = src.indexOf("function to12Hour(");
  const end = src.indexOf("// --- RASTER (IMAGE) PRINTING");
  if (start < 0 || end < 0) throw new Error("could not find the legacy builders in main.js");
  const code = src.slice(start, end);
  const sandbox = {
    Buffer,
    printConfig: { activeType },
    escposCharsPerLine: () => (activeType === "58mm" ? 32 : 48),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code + "\nthis.convertBillToEscPos = convertBillToEscPos;", sandbox);
  return sandbox.convertBillToEscPos;
}

// ---------------------------------------------------------------- engine
function renderTemplate(bill, activeType) {
  const cols = activeType === "58mm" ? 32 : 48;
  const lines = BillTemplate.resolveBill(BillTemplate.DEFAULT_TEMPLATE, bill, { paper: activeType });
  const phys = BillTemplate.fitLines(lines, cols);
  return Buffer.from(BillTemplate.physToEscPos(phys, { paper: activeType }), "latin1");
}

// ---------------------------------------------------------------- parser
function parseEscPos(buf, cols) {
  const ev = [];
  const st = { align: 0, bold: 0, size: 0, ul: 0, inv: 0 };
  let runs = [];
  let qrModule = 3;
  const pushText = (ch) => {
    const last = runs[runs.length - 1];
    const key = `${st.bold}${st.size}${st.ul}${st.inv}`;
    if (last && last.key === key) last.text += ch;
    else runs.push({ key, text: ch, bold: st.bold, size: st.size, ul: st.ul, inv: st.inv });
  };
  const flushLine = () => {
    // trailing spaces never print; drop them, then drop empty runs
    for (let i = runs.length - 1; i >= 0; i--) {
      runs[i].text = runs[i].text.replace(/\s+$/, "");
      if (runs[i].text.length) break;
      runs.pop();
    }
    // A line that fills every column has nowhere to be aligned to, and an
    // empty line has nothing to align: the same ink comes out whatever ESC a
    // says. Treat both as left.
    const width = runs.reduce((n, r) => n + r.text.length * ((r.size & 0x10) ? 2 : 1), 0);
    ev.push({ k: "line", align: width >= cols || width === 0 ? 0 : st.align, runs: runs.map((r) => ({ t: r.text, b: r.bold, s: r.size, u: r.ul, i: r.inv })) });
    runs = [];
  };
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x1b) {
      const c = buf[i + 1];
      if (c === 0x40) { st.align = 0; st.bold = 0; st.size = 0; st.ul = 0; st.inv = 0; i += 2; continue; }
      if (c === 0x61) { st.align = buf[i + 2]; i += 3; continue; }
      if (c === 0x45) { st.bold = buf[i + 2] & 1; i += 3; continue; }
      if (c === 0x2d) { st.ul = buf[i + 2] & 1; i += 3; continue; }
      throw new Error(`unknown ESC sequence at ${i}: ${c}`);
    }
    if (b === 0x1d) {
      const c = buf[i + 1];
      if (c === 0x21) { st.size = buf[i + 2]; i += 3; continue; }
      if (c === 0x42) { st.inv = buf[i + 2] & 1; i += 3; continue; }
      if (c === 0x56) { ev.push({ k: "cut" }); i += 4; continue; }
      if (c === 0x28 && buf[i + 2] === 0x6b) {
        const len = buf[i + 3] + 256 * buf[i + 4];
        const fn = buf[i + 6];
        const data = buf.slice(i + 7, i + 5 + len);
        if (fn === 0x43) qrModule = data[0];
        if (fn === 0x50) ev.push({ k: "qr", data: data.slice(1).toString("latin1"), module: qrModule, align: st.align });
        i += 5 + len;
        continue;
      }
      if (c === 0x76 && buf[i + 2] === 0x30) {
        const w = buf[i + 4] + 256 * buf[i + 5];
        const h = buf[i + 6] + 256 * buf[i + 7];
        ev.push({ k: "raster", w, h });
        i += 8 + w * h;
        continue;
      }
      throw new Error(`unknown GS sequence at ${i}: ${c}`);
    }
    if (b === 0x0a) { flushLine(); i += 1; continue; }
    pushText(String.fromCharCode(b));
    i += 1;
  }
  if (runs.length) flushLine();
  return ev;
}

// ---------------------------------------------------------------- payloads
const base = JSON.parse(JSON.stringify(BillTemplate.SAMPLE_BILL));
const clone = (o) => JSON.parse(JSON.stringify(o));
const variants = [];
const add = (name, mutate, expectDiff) => {
  const b = clone(base);
  mutate(b);
  variants.push({ name, bill: b, expectDiff: !!expectDiff });
};

add("delivery: everything on", () => {});
add("dine-in: table number, nothing optional", (b) => {
  b.type = " Table 5"; b.table_number = 5; b.table_name = null;
  b.customer_name = null; b.customer_phone = null; b.delivery_address = "";
  b.delivery_location = null; b.delivery_boy = null; b.notes = "";
  b.extra_charges = []; b.calculations.discount_amount = 0; b.calculations.gst_amount = 0;
  b.payment_upi_string = null; b.bill_detail_url = null; b.currency = "$";
});
add("dine-in: named table, UAE VAT", (b) => {
  b.type = " Table Garden"; b.table_number = 0; b.table_name = "Garden 2"; b.country = "United Arab Emirates";
  b.currency = "AED"; b.calculations.gst_percentage = 5; b.delivery_boy = null; b.delivery_location = null;
});
add("takeaway: long address wraps, two charges, no gst/fssai/phone", (b) => {
  b.type = "Takeaway"; b.phone = null; b.gst_no = null; b.fssai_licence_no = null;
  b.address = "Sy.No.26/3, 1 Acre 9 Gunta, In Front of Wood Share Villa, Near Infopark Phase 2, Kakkanad, Kochi, Kerala 682042";
  b.extra_charges = [{ name: "Parcel", price: 20 }, { name: "Service charge", price: "15.5" }];
  b.delivery_boy = { name: "", phone: "9700099900" }; b.delivery_location = null;
});
add("long item names that wrap; big quantities", (b) => {
  b.order_items = [
    { name: "Extra Large Family Pack Chicken Biryani with Raita and Salad", price: 899.5, quantity: 12 },
    { name: "Supercalifragilisticexpialidociousmilkshakeofdoom", price: 5, quantity: 1 },
    { name: "Tea", price: 10, quantity: 100 },
  ];
});
add("empty store name, SAR currency, no UPI", (b) => {
  b.store_name = ""; b.currency = "SAR"; b.payment_upi_string = null;
});
// The legacy builder prints a doubled rule here: its collapse compares whole
// lines and the ALIGN_CENTER byte glued to the footer rule defeats it. The
// layout collapses the two, which is what the collapse always meant to do.
add("no calculations at all (legacy prints a doubled rule)", (b) => { b.calculations = null; }, true);
add("payload without an id", (b) => { b.id = ""; b.display_id = "77"; }, true);
add("very long notes (now wrapped at spaces instead of by the printer)", (b) => {
  b.notes = "Please ring the bell twice and leave the parcel with the security guard at the gate if nobody answers";
}, true);
add("wide date and time on 58 mm", (b) => { b.created_at = "06/09/2026"; b.time = "23:59"; });

// ---------------------------------------------------------------- compare
function describe(ev) {
  if (ev.k === "line") return `line a${ev.align} ` + ev.runs.map((r) => `[${r.b ? "B" : ""}${r.s ? "S" + r.s : ""}${r.u ? "U" : ""}${r.i ? "I" : ""}]"${r.t}"`).join("");
  if (ev.k === "qr") return `qr m${ev.module} a${ev.align} ${ev.data}`;
  if (ev.k === "raster") return `raster ${ev.w}x${ev.h}`;
  return ev.k;
}

let failures = 0;
let expected = 0;
for (const activeType of ["80mm", "58mm"]) {
  const legacy = loadLegacy(activeType);
  for (const v of variants) {
    const cols = activeType === "58mm" ? 32 : 48;
    const a = parseEscPos(legacy(clone(v.bill)), cols);
    const b = parseEscPos(renderTemplate(clone(v.bill), activeType), cols);
    const n = Math.max(a.length, b.length);
    let firstDiff = -1;
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(a[i] || null) !== JSON.stringify(b[i] || null)) { firstDiff = i; break; }
    }
    const tag = `${activeType.padEnd(4)} ${v.name}`;
    if (firstDiff === -1) {
      console.log(`  ok   ${tag}  (${a.length} events)`);
      continue;
    }
    if (v.expectDiff) {
      expected += 1;
      console.log(`  ~    ${tag}  differs as expected at event ${firstDiff}:`);
    } else {
      failures += 1;
      console.log(`  FAIL ${tag}  first difference at event ${firstDiff}:`);
    }
    for (let i = Math.max(0, firstDiff - 2); i < Math.min(n, firstDiff + 4); i++) {
      const mark = i === firstDiff ? ">" : " ";
      console.log(`     ${mark} legacy : ${a[i] ? describe(a[i]) : "(none)"}`);
      console.log(`     ${mark} layout : ${b[i] ? describe(b[i]) : "(none)"}`);
    }
  }
}
console.log(`\n${failures ? failures + " FAILURE(S)" : "All matching"}; ${expected} expected difference(s).`);
process.exit(failures ? 1 : 0);
