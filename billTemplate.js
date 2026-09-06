// Bill layout engine for the ESC/POS text bill.
//
// One file, loaded two ways: main.js require()s it to turn a layout + a bill
// payload into printer bytes, and the Bill Layout window (designer.html) loads it
// with a <script> tag to draw the same layout as an HTML preview. Both paths run
// the SAME resolve + fit steps, so what the preview shows is what the printer
// gets, column for column.
//
// Pipeline:
//   resolveBill(template, bill)  -> logical lines  (fields filled, conditions applied)
//   fitLines(lines, cols)        -> physical lines (wrapped and padded to the paper)
//   physToEscPos(phys)           -> ESC/POS bytes as a latin1 string (main.js)
//   physToHtml(phys)             -> preview markup (designer window)
//
// The default layout (DEFAULT_TEMPLATE) reproduces today's convertBillToEscPos
// output; check-template-default.js proves it against real payloads.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BillTemplate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ESC = "\x1B";
  const GS = "\x1D";
  const LF = "\x0A";

  const VERSION = 1;
  const SIZES = ["normal", "tall", "wide", "big"];
  const ALIGNS = ["left", "center", "right"];
  const BLOCK_TYPES = ["text", "row", "rule", "space", "image", "qr", "items", "charges", "group"];
  const QR_SOURCES = ["bill_detail", "upi", "delivery_location", "custom"];
  const QR_SIZES = ["s", "m", "l"];
  const IMAGE_WIDTHS = [25, 50, 75, 100];
  const ORDER_TYPES = ["dine_in", "takeaway", "delivery"];
  const ITEM_COLUMN_KEYS = ["qty", "name", "price", "amount"];
  const MAX_BLOCKS = 300;
  const MAX_TEXT = 1000;

  // ------------------------------------------------------------ helpers
  // Mirrors main.js replaceSpecialChars: the printer font has no currency
  // glyphs and cannot draw non-ASCII, so map what we can and drop the rest.
  function sanitizeForPrinter(str) {
    if (str == null || str === "") return "";
    str = String(str);
    str = str.replace(/₹/g, "Rs.");
    str = str.replace(/€/g, "EUR");
    str = str.replace(/£/g, "GBP");
    str = str.replace(/\$/g, "USD");
    return str.replace(/[^\x00-\x7F]/g, "");
  }

  // Same as main.js to12Hour: "13:40" -> "1:40 PM"; anything else passes through.
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

  // Same as main.js generatedStamp.
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

  const str = (v) => (v == null ? "" : String(v));
  const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : "";
  };
  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const oneOf = (v, list, dflt) => (list.indexOf(v) !== -1 ? v : dflt);
  const capText = (v) => str(v).slice(0, MAX_TEXT);

  let uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return (prefix || "b") + Date.now().toString(36).slice(-4) + (uidCounter).toString(36);
  }

  // "Delivery" / "Takeaway" / " Table 5" / " Parcel (Table 5)" -> a key.
  function orderTypeKey(type) {
    const t = str(type).toLowerCase();
    if (!t) return "";
    if (t.indexOf("delivery") !== -1) return "delivery";
    if (t.indexOf("parcel") !== -1 || t.indexOf("takeaway") !== -1 || t.indexOf("take away") !== -1 || t.indexOf("pickup") !== -1) return "takeaway";
    if (t.indexOf("table") !== -1 || t.indexOf("dine") !== -1) return "dine_in";
    return "";
  }

  // ------------------------------------------------------------ fields
  // Everything the /bill payload carries, named for humans. `labelOnly` fields
  // never count as content for "hide when empty" (a line that only has a
  // currency symbol on it is still empty).
  const calc = (b) => (b && b.calculations) || null;
  // The bill payload carries `order_items`, the KOT payload `items`.
  const items = (b) => (b && Array.isArray(b.order_items) ? b.order_items : (b && Array.isArray(b.items) ? b.items : []));
  const charges = (b) => (b && Array.isArray(b.extra_charges) ? b.extra_charges : []);
  const chargesTotal = (b) => charges(b).reduce((s, c) => s + (parseFloat(c && c.price) || 0), 0);

  const FIELDS = [
    { key: "store_name", group: "Store", label: "Store name", get: (b) => str(b.store_name) || "Restaurant" },
    { key: "address", group: "Store", label: "Store address", get: (b) => str(b.address) },
    { key: "phone", group: "Store", label: "Store phone", get: (b) => str(b.phone) },
    { key: "tax_no", group: "Store", label: "GST / VAT number", get: (b) => str(b.gst_no) },
    { key: "tax_label", group: "Store", label: "GST or VAT (label)", labelOnly: true, get: (b) => (b.country === "United Arab Emirates" ? "VAT" : "GST") },
    { key: "trn", group: "Store", label: "TRN", get: (b) => str(b.trn) },
    { key: "fssai", group: "Store", label: "FSSAI licence", get: (b) => str(b.fssai_licence_no) },

    { key: "order_id", group: "Order", label: "Order id (short)", get: (b) => str(b.id).slice(0, 8) || str(b.display_id) },
    { key: "order_no", group: "Order", label: "Order number", get: (b) => str(b.display_id) },
    { key: "date", group: "Order", label: "Date", get: (b) => str(b.created_at) },
    { key: "time", group: "Order", label: "Time", get: (b) => to12Hour(b.time) },
    { key: "order_type", group: "Order", label: "Order type", get: (b) => str(b.type) },
    { key: "table", group: "Order", label: "Table", get: (b) => str(b.table_name) || (b.table_number ? "Table " + b.table_number : "") },
    { key: "payment_method", group: "Order", label: "Payment method", get: (b) => str(b.payment_method) },
    { key: "notes", group: "Order", label: "Order notes", get: (b) => str(b.notes) },
    { key: "generated_at", group: "Order", label: "Printed at", get: (b) => generatedStamp(b.generated_at) },

    { key: "customer_name", group: "Customer", label: "Customer name", get: (b) => str(b.customer_name) },
    { key: "customer_phone", group: "Customer", label: "Customer phone", get: (b) => str(b.customer_phone) },
    { key: "delivery_address", group: "Customer", label: "Delivery address", get: (b) => str(b.delivery_address) },
    { key: "rider_name", group: "Customer", label: "Delivery boy name", get: (b) => str(b.delivery_boy && b.delivery_boy.name) },
    { key: "rider_phone", group: "Customer", label: "Delivery boy phone", get: (b) => str(b.delivery_boy && b.delivery_boy.phone) },

    { key: "currency", group: "Money", label: "Currency (label)", labelOnly: true, get: (b) => str(b.currency) },
    { key: "subtotal", group: "Money", label: "Subtotal", get: (b) => (calc(b) ? money(calc(b).subtotal) : "") },
    { key: "discount", group: "Money", label: "Discount (blank when none)", get: (b) => (calc(b) && Number(calc(b).discount_amount) > 0 ? money(calc(b).discount_amount) : "") },
    { key: "tax", group: "Money", label: "Tax amount (blank when none)", get: (b) => (calc(b) && Number(calc(b).gst_amount) > 0 ? money(calc(b).gst_amount) : "") },
    { key: "tax_pct", group: "Money", label: "Tax percent", get: (b) => (calc(b) && Number(calc(b).gst_amount) > 0 ? str(calc(b).gst_percentage) : "") },
    { key: "charges_total", group: "Money", label: "Extra charges total", get: (b) => (chargesTotal(b) > 0 ? money(chargesTotal(b)) : "") },
    { key: "grand_total", group: "Money", label: "Grand total", get: (b) => (calc(b) ? money(calc(b).grand_total) : "") },
    { key: "item_count", group: "Money", label: "Number of items", get: (b) => (items(b).length ? String(items(b).length) : "") },
    { key: "total_qty", group: "Money", label: "Total quantity", get: (b) => { const q = items(b).reduce((s, it) => s + (Number(it && it.quantity) || 0), 0); return q ? String(q) : ""; } },
  ];
  const FIELD_MAP = {};
  FIELDS.forEach((f) => { FIELD_MAP[f.key] = f; });

  // Fields available inside the items table (per item).
  const ITEM_FIELDS = [
    { key: "qty", label: "Quantity", get: (it) => str(it.quantity) },
    { key: "name", label: "Item name", get: (it) => str(it.name) },
    { key: "price", label: "Unit price", get: (it) => money(it.price) },
    { key: "amount", label: "Line amount", get: (it) => money((Number(it.quantity) || 0) * (Number(it.price) || 0)) },
    { key: "notes", label: "Item notes", get: (it) => str(it.notes) },
    { key: "category", label: "Category", get: (it) => str(it.category) },
  ];
  const ITEM_FIELD_MAP = {};
  ITEM_FIELDS.forEach((f) => { ITEM_FIELD_MAP[f.key] = f; });

  // What "Only when …" can test. Composite keys first, then any plain field.
  const WHEN_FIELDS = [
    { key: "customer", label: "there is a customer (name, phone or address)" },
    { key: "rider", label: "a delivery boy is assigned" },
    { key: "extra_charges", label: "there are extra charges" },
    { key: "delivery_location", label: "the order has a map pin" },
    { key: "upi", label: "UPI payment QR is available" },
    { key: "bill_detail", label: "the online-bill QR is on" },
    { key: "logo", label: "a store logo is set" },
    { key: "table", label: "there is a table" },
    { key: "notes", label: "there are order notes" },
    { key: "discount", label: "there is a discount" },
    { key: "tax", label: "there is tax" },
    { key: "customer_name", label: "customer name is known" },
    { key: "customer_phone", label: "customer phone is known" },
    { key: "delivery_address", label: "there is a delivery address" },
    { key: "payment_method", label: "payment method is set" },
    { key: "fssai", label: "FSSAI number is set" },
    { key: "tax_no", label: "GST / VAT number is set" },
    { key: "trn", label: "TRN is set" },
  ];

  function hasValue(key, bill) {
    const b = bill || {};
    switch (key) {
      case "customer": return !!(b.customer_name || b.customer_phone || b.delivery_address);
      case "rider": return !!(b.delivery_boy && (b.delivery_boy.name || b.delivery_boy.phone));
      case "extra_charges": return charges(b).length > 0;
      case "items": return items(b).length > 0;
      case "delivery_location": return !!(b.delivery_location && b.delivery_location.google_maps_link);
      case "upi": return !!b.payment_upi_string;
      case "bill_detail": return !!b.bill_detail_url;
      case "logo": return !!(b.store_logo_url || b.bill_logo_url);
      default: {
        const f = FIELD_MAP[key];
        return !!(f && f.get(b));
      }
    }
  }

  function evalWhen(when, bill) {
    if (!when || typeof when !== "object") return true;
    if (Array.isArray(when.orderType)) {
      if (!when.orderType.length) return true;
      return when.orderType.indexOf(orderTypeKey(bill && bill.type)) !== -1;
    }
    if (typeof when.has === "string") return hasValue(when.has, bill);
    if (typeof when.missing === "string") return !hasValue(when.missing, bill);
    return true;
  }

  // ------------------------------------------------------------ markup
  // Inline tags inside a line: <b> <u> <inv> <big> <wide> <tall>. Anything else
  // in angle brackets is plain text. Tags are parsed BEFORE fields are filled
  // in, so a customer called "<b>" cannot restyle the bill.
  const TAG_RE = /<(\/?)(b|u|inv|big|wide|tall)>/gi;
  function parseMarkup(text) {
    const segs = [];
    const state = { bold: 0, underline: 0, invert: 0, sizes: [] };
    let last = 0;
    const push = (v) => {
      if (!v) return;
      segs.push({
        v,
        bold: state.bold > 0,
        underline: state.underline > 0,
        invert: state.invert > 0,
        size: state.sizes.length ? state.sizes[state.sizes.length - 1] : null,
      });
    };
    const src = str(text);
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src))) {
      push(src.slice(last, m.index));
      last = m.index + m[0].length;
      const closing = m[1] === "/";
      const tag = m[2].toLowerCase();
      if (tag === "b") state.bold = Math.max(0, state.bold + (closing ? -1 : 1));
      else if (tag === "u") state.underline = Math.max(0, state.underline + (closing ? -1 : 1));
      else if (tag === "inv") state.invert = Math.max(0, state.invert + (closing ? -1 : 1));
      else {
        if (closing) {
          const i = state.sizes.lastIndexOf(tag);
          if (i !== -1) state.sizes.splice(i, 1);
        } else state.sizes.push(tag);
      }
    }
    push(src.slice(last));
    return segs;
  }

  const TOKEN_RE = /\{([a-z_]+)\}/g;

  // Fill {fields} inside already-parsed segments. Returns the segments plus a
  // count of content tokens and how many of them had a value, for hideIfEmpty.
  function fillSegs(segs, ctx, blockStyle) {
    let tokens = 0;
    let nonEmpty = 0;
    const out = [];
    segs.forEach((seg) => {
      const v = seg.v.replace(TOKEN_RE, (whole, key) => {
        let val = null;
        let labelOnly = false;
        if (ctx.item && ITEM_FIELD_MAP[key]) val = ITEM_FIELD_MAP[key].get(ctx.item);
        else if (FIELD_MAP[key]) { val = FIELD_MAP[key].get(ctx.bill); labelOnly = !!FIELD_MAP[key].labelOnly; }
        if (val === null) return whole; // unknown field: leave it visible
        val = ctx.sanitize(val);
        if (!labelOnly) { tokens += 1; if (val) nonEmpty += 1; }
        return val;
      });
      const s = blockStyle || {};
      out.push({
        v: ctx.sanitize(v),
        bold: !!(seg.bold || s.bold),
        underline: !!(seg.underline || s.underline),
        invert: !!(seg.invert || s.invert),
        size: seg.size || (s.size && s.size !== "normal" ? s.size : null),
      });
    });
    return { segs: out.filter((s) => s.v.length > 0), tokens, nonEmpty };
  }

  function resolveText(text, ctx, blockStyle) {
    return fillSegs(parseMarkup(text), ctx, blockStyle);
  }

  // Cells and captions are one line each: a newline there is just a space.
  const oneLine = (text) => str(text).replace(/\r?\n/g, " ");

  // Break styled segments at newline characters into separate lines.
  function splitSegsOnNewline(segs) {
    const lines = [[]];
    segs.forEach((seg) => {
      const parts = seg.v.split(/\r?\n/);
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part.length) lines[lines.length - 1].push(cloneStyle(seg, part));
      });
    });
    return lines;
  }

  // ------------------------------------------------------------ resolve
  // template + bill -> logical lines. Options:
  //   sanitize: fn(text) -> text for the printer (default sanitizeForPrinter)
  //   preview:  emit hidden/skipped blocks as ghost lines so the designer can
  //             still show where they are (and why they are not printing)
  //   paper:    "58mm" | "80mm" (QR module sizes)
  function resolveBill(template, bill, opts) {
    opts = opts || {};
    const tpl = template && template.blocks ? template : DEFAULT_TEMPLATE;
    // "Per order type": each kind of order has its own list of blocks. An order
    // of an unknown kind, or a kind with no layout, prints the shared one.
    let blocks = tpl.blocks;
    if (tpl.perType && tpl.variants) {
      const kind = orderTypeKey(bill && bill.type) || "delivery";
      const v = tpl.variants[kind];
      if (v && Array.isArray(v.blocks)) blocks = v.blocks;
    }
    const ctx = {
      bill: bill || {},
      sanitize: opts.sanitize || sanitizeForPrinter,
      preview: !!opts.preview,
      paper: opts.paper === "58mm" ? "58mm" : "80mm",
      item: null,
    };
    const out = [];
    walkBlocks(blocks, ctx, out, null, null);
    collapseRules(out);
    const paper = tpl.paper || {};
    const feed = clampInt(paper.feedLines, 0, 10, 3);
    if (feed > 0) out.push({ t: "feed", n: feed });
    if (paper.cut !== false) out.push({ t: "cut" });
    return out;
  }

  function walkBlocks(blocks, ctx, out, ghost, groupId) {
    (blocks || []).forEach((bk) => resolveBlock(bk, ctx, out, ghost, groupId));
  }

  function tagLine(line, bk, ghost, groupId) {
    line.blockId = bk.id;
    if (groupId) line.groupId = groupId;
    if (ghost) line.ghost = ghost;
    return line;
  }

  function resolveBlock(bk, ctx, out, ghost, groupId) {
    if (!bk || typeof bk !== "object") return;
    if (bk.hidden) {
      if (!ctx.preview) return;
      ghost = ghost || "hidden";
    }
    if (bk.when && !evalWhen(bk.when, ctx.bill)) {
      if (!ctx.preview) return;
      ghost = ghost || "condition";
    }
    const emit = (line) => out.push(tagLine(line, bk, ghost, groupId));

    switch (bk.type) {
      case "text": {
        const r = resolveText(bk.text, ctx, bk.style);
        const align = (bk.style && bk.style.align) || "left";
        if (bk.hideIfEmpty !== false && r.tokens > 0 && r.nonEmpty === 0) {
          if (!ctx.preview) return;
          ghost = ghost || "empty";
        }
        // Enter in the text box is a line break, and an empty line prints as
        // a blank line — so one block can hold a few lines with gaps between.
        splitSegsOnNewline(r.segs).forEach((segs) => {
          out.push(tagLine({ t: "text", align, segs, wrap: bk.wrap !== false }, bk, ghost, groupId));
        });
        return;
      }
      case "row": {
        let tokens = 0, nonEmpty = 0;
        const cells = (bk.cells || []).map((c) => {
          const r = resolveText(oneLine(c.text), ctx, bk.style);
          tokens += r.tokens; nonEmpty += r.nonEmpty;
          return { segs: r.segs, align: oneOf(c.align, ALIGNS, "left"), width: c.width === "flex" ? "flex" : (typeof c.width === "number" ? c.width : null) };
        });
        if (bk.hideIfEmpty !== false && tokens > 0 && nonEmpty === 0) {
          if (!ctx.preview) return;
          ghost = ghost || "empty";
        }
        out.push(tagLine({ t: "row", cells }, bk, ghost, groupId));
        return;
      }
      case "rule":
        emit({ t: "rule", ch: str(bk.char) || "-" });
        return;
      case "space":
        emit({ t: "feed", n: clampInt(bk.lines, 1, 10, 1) });
        return;
      case "image": {
        let src = str(bk.src);
        if (src === "logo") {
          // store_logo_url is the uploaded logo whatever the dashboard's "print
          // logo" switch says (a logo block IS the instruction); bill_logo_url
          // is the older key, only present when that switch is on.
          src = str(ctx.bill.store_logo_url) || str(ctx.bill.bill_logo_url);
          if (!src) {
            if (!ctx.preview) return;
            ghost = ghost || "nologo";
          }
        }
        out.push(tagLine({ t: "image", src, width: oneOf(bk.width, IMAGE_WIDTHS, 50), align: oneOf(bk.align, ALIGNS, "center"), logo: bk.src === "logo" }, bk, ghost, groupId));
        return;
      }
      case "qr": {
        const b = ctx.bill;
        let value = "";
        if (bk.source === "bill_detail") value = str(b.bill_detail_url);
        else if (bk.source === "upi") value = str(b.payment_upi_string);
        else if (bk.source === "delivery_location") value = str(b.delivery_location && b.delivery_location.google_maps_link);
        else value = resolveText(bk.value, ctx, null).segs.map((s) => s.v).join("");
        if (!value) {
          if (!ctx.preview) return;
          ghost = ghost || "noqr";
        }
        // Same shape as today: a blank line, the caption, the symbol, a blank
        // line, then anything under it.
        emit({ t: "feed", n: 1 });
        const cap = resolveText(oneLine(bk.caption), ctx, null);
        if (cap.segs.length) emit({ t: "text", align: "center", segs: cap.segs, wrap: true });
        emit({ t: "qr", v: value, size: normalizeQrSize(bk.size), align: "center" });
        emit({ t: "feed", n: 1 });
        const below = resolveText(oneLine(bk.captionBelow), ctx, null);
        if (below.segs.length && !(bk.hideIfEmpty !== false && below.tokens > 0 && below.nonEmpty === 0)) {
          emit({ t: "text", align: "center", segs: below.segs, wrap: true });
        }
        return;
      }
      case "items": {
        const list = items(ctx.bill);
        if (!list.length) {
          if (!ctx.preview) return;
          ghost = ghost || "noitems";
        }
        resolveItems(bk, list, ctx, out, ghost, groupId);
        return;
      }
      case "charges": {
        const list = charges(ctx.bill);
        if (!list.length) {
          if (!ctx.preview) return;
          ghost = ghost || "nocharges";
        }
        const style = bk.style || {};
        list.forEach((c) => {
          const name = fillSegs([{ v: str(c && c.name) }], ctx, style).segs;
          const price = fillSegs([{ v: money(parseFloat(c && c.price) || 0) }], ctx, style).segs;
          emit({ t: "row", cells: [{ segs: name, align: "left", width: "flex" }, { segs: price, align: "right", width: null }] });
        });
        if (!list.length && ctx.preview) {
          emit({ t: "row", cells: [{ segs: [{ v: "(extra charges)" }], align: "left", width: "flex" }, { segs: [{ v: "0.00" }], align: "right", width: null }] });
        }
        return;
      }
      case "group":
        walkBlocks(bk.blocks, ctx, out, ghost, bk.id);
        return;
      default:
        return;
    }
  }

  function resolveItems(bk, list, ctx, out, ghost, groupId) {
    const emit = (line) => out.push(tagLine(line, bk, ghost, groupId));
    const rowStyle = bk.rowStyle || {};
    const nameStyle = bk.nameStyle || null;
    const sample = list.length ? list : [{ name: "(item)", price: 0, quantity: 1 }];
    if (bk.layout === "columns") {
      const columns = normalizeColumns(bk.columns);
      if (bk.header !== false) {
        const hs = bk.headerStyle || { bold: true };
        emit({ t: "row", cells: columns.map((col) => ({ segs: fillSegs([{ v: col.label }], ctx, hs).segs, align: col.align, width: col.width })) });
      }
      sample.forEach((it, idx) => {
        ctx.item = it;
        emit({ t: "row", cells: columns.map((col) => {
          const st = col.key === "name" && nameStyle ? Object.assign({}, rowStyle, nameStyle) : rowStyle;
          return { segs: fillSegs([{ v: "{" + col.key + "}" }], ctx, st).segs, align: col.align, width: col.width };
        }) });
        itemExtras(bk, it, ctx, emit);
        if (bk.separator && idx < sample.length - 1) emit({ t: "rule", ch: "-" });
        ctx.item = null;
      });
      return;
    }
    // inline: "<format> ........ <amount>" — the format wraps, the amount sits on
    // its last line. With showAmount off (a kitchen ticket) it is just the text.
    const format = str(bk.format) || "{qty} x {name}";
    sample.forEach((it, idx) => {
      ctx.item = it;
      const left = resolveText(format, ctx, nameStyle ? Object.assign({}, rowStyle, nameStyle) : rowStyle).segs;
      if (bk.showAmount === false) {
        emit({ t: "text", align: "left", segs: left, wrap: true });
      } else {
        const amount = fillSegs([{ v: "{amount}" }], ctx, rowStyle).segs;
        emit({ t: "row", cells: [{ segs: left, align: "left", width: "flex" }, { segs: amount, align: "right", width: null }] });
      }
      itemExtras(bk, it, ctx, emit);
      if (bk.separator && idx < sample.length - 1) emit({ t: "rule", ch: "-" });
      ctx.item = null;
    });
  }

  function itemExtras(bk, it, ctx, emit) {
    if (bk.showNotes && it && it.notes) {
      emit({ t: "text", align: "left", segs: fillSegs([{ v: "  (Note: " + str(it.notes) + ")" }], ctx, null).segs, wrap: true });
    }
    if (bk.showCategory && it && it.category) {
      emit({ t: "text", align: "left", segs: fillSegs([{ v: "  " + str(it.category) }], ctx, null).segs, wrap: true });
    }
    if (bk.gapAfter) emit({ t: "feed", n: 1 });
  }

  function normalizeColumns(cols) {
    const out = [];
    (Array.isArray(cols) ? cols : []).forEach((c) => {
      if (!c || ITEM_COLUMN_KEYS.indexOf(c.key) === -1) return;
      if (out.some((o) => o.key === c.key)) return;
      const dflt = DEFAULT_COLUMNS.find((d) => d.key === c.key);
      out.push({
        key: c.key,
        label: c.label != null ? capText(c.label) : dflt.label,
        width: c.key === "name" ? "flex" : (typeof c.width === "number" && c.width > 0 ? clampInt(c.width, 1, 40, dflt.width) : dflt.width),
        align: oneOf(c.align, ALIGNS, dflt.align),
      });
    });
    if (!out.length) return DEFAULT_COLUMNS.map((d) => Object.assign({}, d));
    if (!out.some((o) => o.key === "name")) out.splice(Math.min(1, out.length), 0, Object.assign({}, DEFAULT_COLUMNS[1]));
    return out;
  }
  const DEFAULT_COLUMNS = [
    { key: "qty", label: "Qty", width: 4, align: "left" },
    { key: "name", label: "Item", width: "flex", align: "left" },
    { key: "price", label: "Price", width: 8, align: "right" },
    { key: "amount", label: "Amount", width: 9, align: "right" },
  ];

  // Two rules in a row print as one (as today): keep the first, drop repeats.
  function collapseRules(lines) {
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i].t === "rule" && lines[i - 1].t === "rule" && lines[i].ch === lines[i - 1].ch && !lines[i].ghost && !lines[i - 1].ghost) {
        lines.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------ fit
  const isWide = (seg) => seg.size === "wide" || seg.size === "big";
  const segWidth = (seg) => seg.v.length * (isWide(seg) ? 2 : 1);
  const segsWidth = (segs) => segs.reduce((s, seg) => s + segWidth(seg), 0);
  function cloneStyle(seg, v) { return { v, bold: seg.bold, underline: seg.underline, invert: seg.invert, size: seg.size }; }

  // Break styled text into lines no wider than `width` columns, at spaces.
  // Internal spacing is kept when a line fits ("Ph  : 98…" keeps its gap);
  // spaces at a break are dropped; a word longer than the width is cut.
  function wrapSegs(segs, width) {
    width = Math.max(1, width);
    const tokens = [];
    segs.forEach((seg) => {
      const parts = seg.v.split(/(\s+)/);
      parts.forEach((p) => {
        if (!p) return;
        tokens.push({ v: p, seg, space: /^\s+$/.test(p) });
      });
    });
    const lines = [];
    let cur = [];
    let curW = 0;
    const flush = () => {
      while (cur.length && cur[cur.length - 1].space) cur.pop();
      lines.push(cur.map((t) => cloneStyle(t.seg, t.v)));
      cur = [];
      curW = 0;
    };
    const unit = (t) => (isWide(t.seg) ? 2 : 1);
    tokens.forEach((t) => {
      const w = t.v.length * unit(t);
      if (t.space) {
        if (curW === 0) return; // no leading spaces on a wrapped line
        if (curW + w <= width) { cur.push(t); curW += w; }
        else { flush(); }
        return;
      }
      if (curW + w <= width) { cur.push(t); curW += w; return; }
      if (curW > 0) flush();
      // a single word wider than the line: hard-split it
      let rest = t.v;
      const per = Math.max(1, Math.floor(width / unit(t)));
      while (rest.length > per) {
        cur.push({ v: rest.slice(0, per), seg: t.seg, space: false });
        curW = per * unit(t);
        flush();
        rest = rest.slice(per);
      }
      if (rest.length) { cur.push({ v: rest, seg: t.seg, space: false }); curW = rest.length * unit(t); }
    });
    if (cur.length || !lines.length) flush();
    return lines;
  }

  function trimRight(segs) {
    const out = segs.map((s) => Object.assign({}, s));
    while (out.length) {
      const last = out[out.length - 1];
      last.v = last.v.replace(/\s+$/, "");
      if (last.v.length) break;
      out.pop();
    }
    return out;
  }

  // Padding takes the style every segment on the line shares (a bold row stays
  // bold through its gap, an underlined row draws its line through the gap),
  // never a size: a padding space is always one column.
  const spaces = (n, style) => (n > 0 ? {
    v: " ".repeat(n),
    bold: !!(style && style.bold), underline: !!(style && style.underline), invert: !!(style && style.invert), size: null,
  } : null);

  function commonStyle(segs) {
    const real = segs.filter((s) => s && s.v.length);
    if (!real.length) return null;
    return {
      bold: real.every((s) => s.bold),
      underline: real.every((s) => s.underline),
      invert: real.every((s) => s.invert),
    };
  }

  function padSegs(segs, width, align, style) {
    const w = segsWidth(segs);
    let pad = width - w;
    if (pad <= 0) return segs.slice();
    if (align === "right") return [spaces(pad, style)].concat(segs);
    if (align === "center") {
      const left = Math.floor(pad / 2);
      const out = [];
      if (left) out.push(spaces(left, style));
      out.push.apply(out, segs);
      if (pad - left) out.push(spaces(pad - left, style));
      return out;
    }
    return segs.concat([spaces(pad, style)]);
  }

  // Cut styled text to `width` columns (fixed table columns only).
  function truncSegs(segs, width) {
    const out = [];
    let used = 0;
    for (const seg of segs) {
      const unit = isWide(seg) ? 2 : 1;
      const room = Math.floor((width - used) / unit);
      if (room <= 0) break;
      if (seg.v.length <= room) { out.push(seg); used += seg.v.length * unit; }
      else { out.push(cloneStyle(seg, seg.v.slice(0, room))); break; }
    }
    return out;
  }

  function fitRow(line, cols) {
    const cells = line.cells || [];
    const out = [];
    const base = (segs, align) => ({ t: "text", align: align || "left", segs: trimRight(segs), blockId: line.blockId, groupId: line.groupId, ghost: line.ghost });
    if (!cells.length) return [base([], "left")];
    if (cells.length === 1) return wrapSegs(cells[0].segs, cols).map((segs) => base(segs, cells[0].align));

    let flexIdx = cells.findIndex((c) => c.width === "flex");
    if (flexIdx < 0) flexIdx = 0;
    const widths = [];
    let fixedTotal = 0;
    cells.forEach((c, i) => {
      if (i === flexIdx) { widths[i] = null; return; }
      widths[i] = typeof c.width === "number" && c.width > 0 ? c.width : segsWidth(c.segs);
      fixedTotal += widths[i];
    });
    const gaps = cells.length - 1;
    const flexW = cols - fixedTotal - gaps;
    const rowStyle = commonStyle(cells.reduce((all, c) => all.concat(c.segs), []));

    const composeOthers = (flexSegs, flexWidth) => {
      const parts = [];
      cells.forEach((c, i) => {
        if (i > 0) parts.push(spaces(1, rowStyle));
        if (i === flexIdx) parts.push.apply(parts, padSegs(flexSegs, flexWidth, c.align, rowStyle));
        else parts.push.apply(parts, padSegs(truncSegs(c.segs, widths[i]), widths[i], c.align, rowStyle));
      });
      return parts.filter(Boolean);
    };

    if (flexW < 1) {
      // Too wide for one line (as today's pair(): the left on its own line, the
      // rest right-aligned on the next).
      wrapSegs(cells[flexIdx].segs, cols).forEach((segs) => out.push(base(segs, "left")));
      const rest = [];
      cells.forEach((c, i) => {
        if (i === flexIdx) return;
        if (rest.length) rest.push(spaces(1, rowStyle));
        rest.push.apply(rest, truncSegs(c.segs, widths[i]));
      });
      out.push(base(padSegs(rest, cols, "right", rowStyle), "left"));
      return out;
    }

    const flexLines = wrapSegs(cells[flexIdx].segs, flexW);
    flexLines.forEach((segs, i) => {
      if (i < flexLines.length - 1) out.push(base(segs, "left"));
      else out.push(base(composeOthers(segs, flexW), "left"));
    });
    return out;
  }

  // logical lines -> physical lines (each fits the paper). Rules, feeds and
  // rows all become text lines; QR, image and cut pass through.
  function fitLines(lines, cols) {
    cols = clampInt(cols, 8, 200, 48);
    const out = [];
    lines.forEach((line) => {
      const carry = (l) => { l.blockId = line.blockId; l.groupId = line.groupId; if (line.ghost) l.ghost = line.ghost; return l; };
      switch (line.t) {
        case "text": {
          const align = oneOf(line.align, ALIGNS, "left");
          if (line.wrap === false) { out.push(carry({ t: "text", align, segs: trimRight(line.segs) })); break; }
          wrapSegs(line.segs, cols).forEach((segs) => out.push(carry({ t: "text", align, segs: trimRight(segs) })));
          break;
        }
        case "row":
          fitRow(line, cols).forEach((l) => out.push(l));
          break;
        case "rule": {
          const ch = line.ch || "-";
          out.push(carry({ t: "text", align: "left", rule: true, segs: [{ v: ch.repeat(Math.ceil(cols / ch.length)).slice(0, cols), bold: false, underline: false, invert: false, size: null }] }));
          break;
        }
        case "feed":
          for (let i = 0; i < clampInt(line.n, 1, 10, 1); i++) out.push(carry({ t: "text", align: "left", blank: true, segs: [] }));
          break;
        case "qr":
          out.push(carry({ t: "qr", v: line.v, size: line.size, align: "center" }));
          break;
        case "image":
          out.push(carry({ t: "image", src: line.src, width: line.width, align: line.align, raster: line.raster, logo: line.logo }));
          break;
        case "cut":
          out.push({ t: "cut" });
          break;
        default:
          break;
      }
    });
    return out;
  }

  // ------------------------------------------------------------ ESC/POS
  // Same QR command sequence as main.js printQRCode (model 2, EC level L).
  function escposQr(data, moduleSize) {
    const mod = String.fromCharCode(Math.max(1, Math.min(16, moduleSize || 3)));
    let q = "";
    q += GS + "(k" + "\x03\x00" + "\x31" + "\x43" + mod;
    q += GS + "(k" + "\x03\x00" + "\x31" + "\x45" + "\x30";
    const len = data.length + 3;
    q += GS + "(k" + String.fromCharCode(len % 256) + String.fromCharCode(Math.floor(len / 256)) + "\x31" + "\x50" + "\x30" + data;
    q += GS + "(k" + "\x03\x00" + "\x31" + "\x51" + "\x30";
    return q;
  }

  // QR geometry. Two kinds of size:
  //   "s" | "m" | "l"  — the original fixed module sizes ("s" on either paper is
  //                      what today's location/UPI QRs use; "m" on 80 mm is
  //                      today's online-bill QR). Kept so the default layout
  //                      prints exactly as before.
  //   10..100 (number) — the symbol's width as a percentage of the paper. The
  //                      module count comes from the data length (byte mode,
  //                      error correction L, as escposQr sets), so the dots per
  //                      module follow: bigger percentage, bigger print.
  const QR_BYTE_CAPACITY_L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858];
  function qrModulesFor(data) {
    const n = str(data).length;
    for (let v = 0; v < QR_BYTE_CAPACITY_L.length; v++) {
      if (n <= QR_BYTE_CAPACITY_L[v]) return 21 + 4 * v;
    }
    return 21 + 4 * QR_BYTE_CAPACITY_L.length;
  }
  function paperDots(paper) { return paper === "58mm" ? 384 : 576; }
  function qrGeometry(data, size, paper) {
    const modules = qrModulesFor(data);
    let module;
    if (typeof size === "number" && Number.isFinite(size)) {
      const pct = Math.min(100, Math.max(10, size));
      module = Math.max(1, Math.min(16, Math.floor((paperDots(paper) * pct) / 100 / modules)));
    } else {
      const map = paper === "58mm" ? { s: 3, m: 3, l: 4 } : { s: 3, m: 4, l: 6 };
      module = map[size] || map.s;
    }
    return { modules, module, dots: modules * module, percent: Math.round((modules * module * 100) / paperDots(paper)) };
  }
  function qrModule(size, paper, data) {
    return qrGeometry(data || "", size, paper).module;
  }

  const SIZE_BYTE = { normal: 0x00, tall: 0x01, wide: 0x10, big: 0x11 };

  // physical lines -> ESC/POS as a latin1 string (Buffer.from(s, "latin1")).
  // Commands are emitted only when a style actually changes, like a person
  // typing the bill would do.
  function physToEscPos(phys, opts) {
    opts = opts || {};
    const paper = opts.paper === "58mm" ? "58mm" : "80mm";
    let out = ESC + "@";
    const st = { align: "left", bold: false, size: "normal", underline: false, invert: false };
    const setAlign = (a) => {
      if (a === st.align) return;
      st.align = a;
      out += ESC + "a" + (a === "center" ? "\x01" : a === "right" ? "\x02" : "\x00");
    };
    const setStyle = (seg) => {
      const bold = !!seg.bold, underline = !!seg.underline, invert = !!seg.invert;
      const size = seg.size && SIZE_BYTE[seg.size] !== undefined ? seg.size : "normal";
      if (bold !== st.bold) { st.bold = bold; out += ESC + "E" + (bold ? "\x01" : "\x00"); }
      if (size !== st.size) { st.size = size; out += GS + "!" + String.fromCharCode(SIZE_BYTE[size]); }
      if (underline !== st.underline) { st.underline = underline; out += ESC + "-" + (underline ? "\x01" : "\x00"); }
      if (invert !== st.invert) { st.invert = invert; out += GS + "B" + (invert ? "\x01" : "\x00"); }
    };
    const plain = { bold: false, underline: false, invert: false, size: null };
    phys.forEach((line) => {
      if (line.t === "cut") {
        setStyle(plain);
        out += GS + "V" + "\x42" + "\x00";
        return;
      }
      if (line.t === "qr") {
        setAlign("center");
        setStyle(plain);
        out += escposQr(sanitizeForPrinter(line.v), qrModule(line.size, paper, sanitizeForPrinter(line.v)));
        return;
      }
      if (line.t === "image") {
        if (!line.raster) return; // nothing could be fetched: skip, never crash a print
        setAlign(line.align || "center");
        setStyle(plain);
        out += line.raster;
        return;
      }
      setAlign(line.align || "left");
      (line.segs || []).forEach((seg) => {
        if (!seg.v) return;
        setStyle(seg);
        out += seg.v.replace(/[^\x00-\x7F]/g, "");
      });
      out += LF;
    });
    return out;
  }

  // ------------------------------------------------------------ HTML preview
  function escapeHtml(s) {
    return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const GHOST_TEXT = {
    hidden: "Hidden (eye off) — not printed",
    condition: "Not printed: its condition is not met on this order",
    empty: "Not printed: no value on this order",
    nologo: "Not printed: no store logo set in the dashboard",
    noqr: "Not printed: nothing to encode on this order",
    noitems: "No items on this order",
    nocharges: "Not printed: no extra charges on this order",
  };

  // physical lines -> preview markup. Each output line carries data-block so the
  // designer can map a click back to its block.
  function physToHtml(phys, opts) {
    opts = opts || {};
    const selected = opts.selectedId || null;
    const html = [];
    phys.forEach((line) => {
      if (line.t === "cut") { html.push('<div class="pl cut"><span>cut</span></div>'); return; }
      const cls = ["pl"];
      if (line.blockId && line.blockId === selected) cls.push("sel");
      if (line.ghost) cls.push("ghost");
      const attrs = ' data-block="' + escapeHtml(line.blockId || "") + '"' +
        (line.groupId ? ' data-group="' + escapeHtml(line.groupId) + '"' : "") +
        (line.ghost ? ' title="' + escapeHtml(GHOST_TEXT[line.ghost] || line.ghost) + '"' : "");
      if (line.t === "qr") {
        // Font A is 12 dots wide, so dots / 12 = character cells.
        const g = qrGeometry(sanitizeForPrinter(line.v), line.size, opts.paper);
        const ch = (g.dots / 12).toFixed(1);
        html.push('<div class="' + cls.join(" ") + ' qrline"' + attrs + ' style="text-align:center"><span class="qrph" style="width:' + ch + 'ch;height:' + ch + 'ch"></span></div>');
        return;
      }
      if (line.t === "image") {
        const src = line.previewSrc || line.src;
        const inner = src
          ? '<img src="' + escapeHtml(src) + '" style="width:' + (line.width || 50) + '%" alt="">'
          : '<span class="imgph" style="width:' + (line.width || 50) + '%">' + (line.logo ? "store logo" : "image") + '</span>';
        html.push('<div class="' + cls.join(" ") + ' imgline"' + attrs + ' style="text-align:' + (line.align || "center") + '">' + inner + '</div>');
        return;
      }
      let tall = false;
      const parts = (line.segs || []).map((seg) => {
        const c = [];
        if (seg.bold) c.push("b");
        if (seg.underline) c.push("u");
        if (seg.invert) c.push("inv");
        if (seg.size === "tall" || seg.size === "big") tall = true;
        const text = escapeHtml(seg.v);
        if (seg.size === "wide" || seg.size === "big") {
          const w = seg.v.length * 2;
          return '<span class="wrap-wide" style="width:' + w + 'ch"><span class="' + (c.concat([seg.size === "big" ? "sz-big" : "sz-wide"]).join(" ")) + '">' + text + '</span></span>';
        }
        if (seg.size === "tall") return '<span class="' + c.concat(["sz-tall"]).join(" ") + '">' + text + '</span>';
        return c.length ? '<span class="' + c.join(" ") + '">' + text + '</span>' : text;
      });
      if (tall) cls.push("h2");
      if (line.rule) cls.push("rule");
      if (line.blank) cls.push("blank");
      html.push('<div class="' + cls.join(" ") + '"' + attrs + ' style="text-align:' + (line.align || "left") + '">' + (parts.join("") || "&nbsp;") + "</div>");
    });
    return html.join("");
  }

  // ------------------------------------------------------------ template shape
  // A percentage (10-100) or one of the legacy letters; anything else is "s".
  function normalizeQrSize(v) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.min(100, Math.max(10, Math.round(v)));
    if (typeof v === "string" && /^\d+$/.test(v)) return Math.min(100, Math.max(10, parseInt(v, 10)));
    return oneOf(v, QR_SIZES, "s");
  }

  function normalizeStyle(s) {
    if (!s || typeof s !== "object") return undefined;
    const out = {};
    if (s.bold) out.bold = true;
    if (s.underline) out.underline = true;
    if (s.invert) out.invert = true;
    if (SIZES.indexOf(s.size) !== -1 && s.size !== "normal") out.size = s.size;
    if (ALIGNS.indexOf(s.align) !== -1 && s.align !== "left") out.align = s.align;
    return Object.keys(out).length ? out : undefined;
  }

  function normalizeWhen(w) {
    if (!w || typeof w !== "object") return undefined;
    if (Array.isArray(w.orderType)) {
      const list = w.orderType.filter((t) => ORDER_TYPES.indexOf(t) !== -1);
      return list.length ? { orderType: list } : undefined;
    }
    if (typeof w.has === "string" && w.has) return { has: w.has.slice(0, 40) };
    if (typeof w.missing === "string" && w.missing) return { missing: w.missing.slice(0, 40) };
    return undefined;
  }

  function normalizeBlock(raw, seen, depth) {
    if (!raw || typeof raw !== "object" || BLOCK_TYPES.indexOf(raw.type) === -1) return null;
    let id = str(raw.id).slice(0, 40);
    if (!id || seen[id]) id = uid(raw.type.slice(0, 2));
    seen[id] = true;
    const b = { id, type: raw.type };
    if (raw.hidden) b.hidden = true;
    const when = normalizeWhen(raw.when);
    if (when) b.when = when;
    switch (raw.type) {
      case "text":
        b.text = capText(raw.text);
        if (normalizeStyle(raw.style)) b.style = normalizeStyle(raw.style);
        if (raw.hideIfEmpty === false) b.hideIfEmpty = false;
        if (raw.wrap === false) b.wrap = false;
        break;
      case "row": {
        b.cells = (Array.isArray(raw.cells) ? raw.cells : []).slice(0, 4).map((c) => {
          const cell = { text: capText(c && c.text) };
          if (c && ALIGNS.indexOf(c.align) !== -1 && c.align !== "left") cell.align = c.align;
          if (c && c.width === "flex") cell.width = "flex";
          else if (c && typeof c.width === "number" && c.width > 0) cell.width = clampInt(c.width, 1, 60, 10);
          return cell;
        });
        if (!b.cells.length) b.cells = [{ text: "" }, { text: "", align: "right" }];
        if (normalizeStyle(raw.style)) b.style = normalizeStyle(raw.style);
        if (raw.hideIfEmpty === false) b.hideIfEmpty = false;
        break;
      }
      case "rule":
        if (raw.char != null && str(raw.char).length && str(raw.char) !== "-") b.char = str(raw.char).slice(0, 8);
        break;
      case "space":
        b.lines = clampInt(raw.lines, 1, 10, 1);
        break;
      case "image": {
        const src = str(raw.src);
        if (src === "logo" || /^https:\/\//i.test(src) || /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,/i.test(src)) b.src = src.length > 200000 ? "logo" : src;
        else b.src = "logo";
        b.width = oneOf(raw.width, IMAGE_WIDTHS, 50);
        if (ALIGNS.indexOf(raw.align) !== -1 && raw.align !== "center") b.align = raw.align;
        break;
      }
      case "qr":
        b.source = oneOf(raw.source, QR_SOURCES, "bill_detail");
        if (b.source === "custom") b.value = capText(raw.value);
        b.size = normalizeQrSize(raw.size);
        if (raw.caption != null && str(raw.caption)) b.caption = capText(raw.caption);
        if (raw.captionBelow != null && str(raw.captionBelow)) b.captionBelow = capText(raw.captionBelow);
        break;
      case "items":
        b.layout = raw.layout === "columns" ? "columns" : "inline";
        if (b.layout === "inline") b.format = capText(raw.format) || "{qty} x {name}";
        else {
          b.columns = normalizeColumns(raw.columns);
          if (raw.header === false) b.header = false;
          if (normalizeStyle(raw.headerStyle)) b.headerStyle = normalizeStyle(raw.headerStyle);
        }
        if (normalizeStyle(raw.rowStyle)) b.rowStyle = normalizeStyle(raw.rowStyle);
        if (normalizeStyle(raw.nameStyle)) b.nameStyle = normalizeStyle(raw.nameStyle);
        if (raw.showNotes) b.showNotes = true;
        if (raw.showCategory) b.showCategory = true;
        if (raw.separator) b.separator = true;
        if (raw.showAmount === false) b.showAmount = false;
        if (raw.gapAfter) b.gapAfter = true;
        break;
      case "charges":
        if (normalizeStyle(raw.style)) b.style = normalizeStyle(raw.style);
        break;
      case "group": {
        b.label = capText(raw.label).slice(0, 60) || "Section";
        b.blocks = [];
        if (depth === 0) {
          (Array.isArray(raw.blocks) ? raw.blocks : []).forEach((child) => {
            if (child && child.type === "group") return; // one level deep
            const nb = normalizeBlock(child, seen, 1);
            if (nb) b.blocks.push(nb);
          });
        }
        break;
      }
      default:
        return null;
    }
    return b;
  }

  // Validate + clean a layout from anywhere (disk, the account, a hand edit).
  // Returns null when it is not a layout at all.
  function normalizeTemplate(raw) {
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.blocks)) return null;
    if (raw.v != null && Number(raw.v) !== VERSION) return null;
    const normalizeList = (list) => {
      const seen = {};
      const blocks = [];
      let count = 0;
      for (const rb of list) {
        if (count >= MAX_BLOCKS) break;
        const nb = normalizeBlock(rb, seen, 0);
        if (!nb) continue;
        blocks.push(nb);
        count += 1 + (nb.blocks ? nb.blocks.length : 0);
      }
      return blocks;
    };
    const blocks = normalizeList(raw.blocks);
    const paper = raw.paper && typeof raw.paper === "object" ? raw.paper : {};
    const out = {
      v: VERSION,
      paper: { feedLines: clampInt(paper.feedLines, 0, 10, 3), cut: paper.cut !== false },
      blocks,
    };
    // Separate layouts per kind of order (delivery / takeaway / dine_in).
    let variants = null;
    if (raw.variants && typeof raw.variants === "object") {
      ORDER_TYPES.forEach((k) => {
        const v = raw.variants[k];
        if (v && Array.isArray(v.blocks)) (variants = variants || {})[k] = { blocks: normalizeList(v.blocks) };
      });
    }
    if (raw.perType) {
      variants = variants || {};
      ORDER_TYPES.forEach((k) => { if (!variants[k]) variants[k] = { blocks: JSON.parse(JSON.stringify(blocks)) }; });
      out.perType = true;
    }
    if (variants) out.variants = variants;
    return out;
  }

  function newBlock(type) {
    const id = uid(type.slice(0, 2));
    switch (type) {
      case "text": return { id, type, text: "New line" };
      case "row": return { id, type, cells: [{ text: "Label:" }, { text: "{grand_total}", align: "right" }] };
      case "rule": return { id, type };
      case "space": return { id, type, lines: 1 };
      case "image": return { id, type, src: "logo", width: 50 };
      case "qr": return { id, type, source: "bill_detail", size: 30, caption: "Scan for bill details" };
      case "items": return { id, type, layout: "inline", format: "{qty} x {name}" };
      case "charges": return { id, type };
      case "group": return { id, type, label: "Section", blocks: [] };
      default: return null;
    }
  }

  const TYPE_LABELS = {
    text: "Text line", row: "Two-column row", rule: "Separator", space: "Blank space",
    image: "Image / logo", qr: "QR code", items: "Items table", charges: "Extra charges", group: "Section",
  };

  function summarizeBlock(b) {
    switch (b.type) {
      case "text": return b.text || "(empty line)";
      case "row": return (b.cells || []).map((c) => c.text || "").join(" │ ");
      case "rule": return (b.char || "-").repeat(8);
      case "space": return b.lines === 1 ? "1 blank line" : b.lines + " blank lines";
      case "image": return (b.src === "logo" ? "Store logo" : "Image") + " · " + (b.width || 50) + "%";
      case "qr": {
        const names = { bill_detail: "Online bill", upi: "UPI payment", delivery_location: "Delivery location", custom: "Custom" };
        return (names[b.source] || "QR") + (b.caption ? " · “" + b.caption + "”" : "");
      }
      case "items": return b.layout === "columns" ? "Columns: " + (b.columns || DEFAULT_COLUMNS).map((c) => c.label).join(" · ") : (b.format || "{qty} x {name}") + (b.showAmount === false ? "" : " · amount right");
      case "charges": return "One row per extra charge";
      case "group": return b.label || "Section";
      default: return b.type;
    }
  }

  // ------------------------------------------------------------ defaults
  // Today's bill, block by block. Rendering this against a payload must give
  // the same output as convertBillToEscPos (see check-template-default.js).
  const DEFAULT_TEMPLATE = {
    v: 1,
    paper: { feedLines: 3, cut: true },
    blocks: [
      { id: "logo", type: "image", src: "logo", width: 50 },
      { id: "name", type: "text", text: "{store_name}", style: { align: "center", bold: true } },
      { id: "addr", type: "text", text: "{address}", style: { align: "center" } },
      { id: "tel", type: "text", text: "Tel: {phone}", style: { align: "center" } },
      { id: "r1", type: "rule" },
      { id: "table", type: "group", label: "Table", when: { has: "table" }, blocks: [
        { id: "t1", type: "text", text: "{table}", style: { align: "center", bold: true } },
        { id: "t2", type: "rule" },
      ] },
      { id: "ord", type: "text", text: "Order: #{order_id}" },
      { id: "dt", type: "row", cells: [{ text: "Date : {date}" }, { text: "Time: {time}", align: "right" }] },
      { id: "type", type: "text", text: "Type : {order_type}" },
      { id: "pay", type: "text", text: "Pay  : {payment_method}" },
      { id: "cust", type: "group", label: "Customer details", when: { has: "customer" }, blocks: [
        { id: "c0", type: "rule" },
        { id: "c1", type: "text", text: "Customer Details:", style: { bold: true } },
        { id: "c2", type: "text", text: "Name: {customer_name}" },
        { id: "c3", type: "text", text: "Ph  : {customer_phone}" },
        { id: "c4", type: "text", text: "Address:", when: { has: "delivery_address" } },
        { id: "c5", type: "text", text: "{delivery_address}" },
      ] },
      { id: "rider", type: "group", label: "Delivery boy", when: { has: "rider" }, blocks: [
        { id: "d0", type: "rule" },
        { id: "d1", type: "text", text: "Delivery Boy", style: { bold: true } },
        { id: "d2", type: "text", text: "Name: {rider_name}" },
        { id: "d3", type: "text", text: "Ph  : {rider_phone}" },
        { id: "d4", type: "rule" },
      ] },
      { id: "notes", type: "group", label: "Order notes", when: { has: "notes" }, blocks: [
        { id: "n0", type: "rule" },
        { id: "n1", type: "text", text: "Order Notes:", style: { bold: true } },
        { id: "n2", type: "text", text: "{notes}" },
      ] },
      { id: "r2", type: "rule" },
      { id: "ih", type: "text", text: "ITEMS", style: { bold: true } },
      { id: "items", type: "items", layout: "inline", format: "{qty} x {name}" },
      { id: "chg", type: "group", label: "Extra charges", when: { has: "extra_charges" }, blocks: [
        { id: "x0", type: "rule" },
        { id: "x1", type: "charges" },
      ] },
      { id: "r3", type: "rule" },
      { id: "sub", type: "row", cells: [{ text: "Subtotal:" }, { text: "{currency} {subtotal}", align: "right" }] },
      { id: "disc", type: "row", cells: [{ text: "Discount:" }, { text: "-{currency} {discount}", align: "right" }] },
      { id: "tax", type: "row", cells: [{ text: "{tax_label} ({tax_pct}%):" }, { text: "{currency} {tax}", align: "right" }] },
      { id: "total", type: "row", style: { bold: true }, cells: [{ text: "TOTAL:" }, { text: "{currency} {grand_total}", align: "right" }] },
      { id: "r4", type: "rule" },
      { id: "thanks", type: "text", text: "Thank you for your visit!", style: { align: "center" } },
      { id: "gen", type: "text", text: "Generated at: {generated_at}", style: { align: "center" } },
      { id: "taxno", type: "text", text: "{tax_label}: {tax_no}", style: { align: "center" } },
      { id: "fssai", type: "text", text: "FSSAI: {fssai}", style: { align: "center" } },
      { id: "qrloc", type: "qr", source: "delivery_location", size: "s", caption: "Scan for Location" },
      { id: "qrpay", type: "qr", source: "upi", size: "s", caption: "Scan to Pay", captionBelow: "{currency} {grand_total}" },
      { id: "qrbill", type: "qr", source: "bill_detail", size: "m", caption: "Scan for bill details" },
      { id: "sp", type: "space", lines: 1 },
      { id: "pow", type: "text", text: "Powered By Menuthere", style: { align: "center" } },
    ],
  };

  // Today's kitchen ticket, block by block (convertOrderToEscPos in main.js);
  // check-template-default.js proves the match.
  const DEFAULT_KOT_TEMPLATE = {
    v: 1,
    paper: { feedLines: 3, cut: true },
    blocks: [
      { id: "khead", type: "text", text: "KITCHEN ORDER TICKET", style: { align: "center", bold: true } },
      { id: "kr1", type: "rule" },
      { id: "ktable", type: "group", label: "Table", when: { has: "table" }, blocks: [
        { id: "kt1", type: "text", text: "{table}", style: { align: "center", bold: true } },
        { id: "kt2", type: "rule" },
      ] },
      { id: "kord", type: "text", text: "Order: #{order_id}" },
      { id: "ktype", type: "text", text: "Type : {order_type}" },
      { id: "ktime", type: "text", text: "Time : {time}" },
      { id: "knotes", type: "group", label: "Order notes", when: { has: "notes" }, blocks: [
        { id: "kn0", type: "space", lines: 1 },
        { id: "kn1", type: "text", text: "Order Notes:", style: { bold: true } },
        { id: "kn2", type: "text", text: "{notes}" },
      ] },
      { id: "kr2", type: "rule" },
      { id: "kih", type: "text", text: "ITEMS:", style: { bold: true } },
      { id: "kitems", type: "items", layout: "inline", format: "{qty} x {name}", showAmount: false, showNotes: true, gapAfter: true, rowStyle: { bold: true } },
      { id: "kr3", type: "rule" },
      { id: "kgen", type: "text", text: "Generated at: {generated_at}", style: { align: "center" } },
      { id: "ksp", type: "space", lines: 1 },
      { id: "kpow", type: "text", text: "Powered By Menuthere", style: { align: "center" } },
    ],
  };

  // A realistic delivery order for the preview and test prints: it has a
  // customer, a rider, a discount, tax, an extra charge and all three QR sources,
  // so every block of the default layout is exercised.
  const SAMPLE_BILL = {
    id: "a1b2c3d4-5e6f-7890-abcd-ef1234567890",
    display_id: "42-06/09/2026", // as the /bill page sends it: number-date, or the short id
    created_at: "06/09/2026",
    time: "13:40",
    store_name: "Mehroo Kitchen",
    address: "12 MG Road, Kochi",
    phone: "9876543210",
    gst_no: "32ABCDE1234F1Z5",
    fssai_licence_no: "11223344556677",
    trn: null,
    country: "India",
    currency: "₹",
    table_number: null,
    table_name: null,
    type: "Delivery",
    payment_method: "cash",
    notes: "Less spicy please",
    customer_name: "Anita R",
    customer_phone: "9800011122",
    delivery_address: "Flat 4B, Palm Grove, Kakkanad",
    delivery_location: { coordinates: [76.35, 10.01], google_maps_link: "https://www.google.com/maps/place/10.01,76.35" },
    delivery_boy: { name: "Suresh", phone: "9700099900" },
    generated_at: "06/09/2026, 1:41:12 PM",
    order_items: [
      { name: "Chicken Biryani", price: 230, quantity: 2, category: "Biryani" },
      { name: "Raita", price: 40, quantity: 1, category: "Sides" },
      { name: "Mango Lassi", price: 90, quantity: 1, category: "Drinks" },
    ],
    extra_charges: [{ name: "Delivery charge", price: 30 }],
    calculations: { food_subtotal: 590, charges_subtotal: 30, discount_amount: 50, subtotal: 620, gst_percentage: 5, gst_amount: 28.5, grand_total: 598.5 },
    payment_upi_string: "upi://pay?pa=mehroo@upi&pn=Mehroo%20Kitchen&am=598.50&cu=INR",
    bill_detail_url: "https://menuthere.com/bill/a1b2c3d4-5e6f-7890-abcd-ef1234567890?print=false",
    bill_logo_url: null,
    show_powered_by_cravings: true,
  };

  // The same sample as a takeaway and as a dine-in order, so a layout's
  // conditions (customer details, rider, table) can be checked for each kind
  // of order. `type` strings are what the /bill page emits for each.
  const SAMPLE_BILL_TAKEAWAY = Object.assign({}, SAMPLE_BILL, {
    id: "b2c3d4e5-6f70-8192-a3b4-c5d6e7f80912",
    display_id: "43-06/09/2026",
    type: "Takeaway",
    payment_method: "upi",
    notes: "Extra napkins please",
    delivery_address: "",
    delivery_location: null,
    delivery_boy: null,
    extra_charges: [{ name: "Parcel", price: 20 }],
    calculations: { food_subtotal: 590, charges_subtotal: 20, discount_amount: 50, subtotal: 610, gst_percentage: 5, gst_amount: 28.5, grand_total: 588.5 },
    payment_upi_string: "upi://pay?pa=mehroo@upi&pn=Mehroo%20Kitchen&am=588.50&cu=INR",
    bill_detail_url: "https://menuthere.com/bill/b2c3d4e5-6f70-8192-a3b4-c5d6e7f80912?print=false",
  });
  const SAMPLE_BILL_DINE_IN = Object.assign({}, SAMPLE_BILL, {
    id: "c3d4e5f6-7081-92a3-b4c5-d6e7f8091a23",
    display_id: "44-06/09/2026",
    type: " Table 5",
    table_number: 5,
    table_name: null,
    payment_method: "cash",
    notes: "Birthday table, cake last",
    customer_name: null,
    customer_phone: null,
    delivery_address: "",
    delivery_location: null,
    delivery_boy: null,
    extra_charges: [],
    calculations: { food_subtotal: 590, charges_subtotal: 0, discount_amount: 50, subtotal: 590, gst_percentage: 5, gst_amount: 28.5, grand_total: 568.5 },
    payment_upi_string: "upi://pay?pa=mehroo@upi&pn=Mehroo%20Kitchen&am=568.50&cu=INR",
    bill_detail_url: "https://menuthere.com/bill/c3d4e5f6-7081-92a3-b4c5-d6e7f8091a23?print=false",
  });
  const SAMPLE_BILLS = { delivery: SAMPLE_BILL, takeaway: SAMPLE_BILL_TAKEAWAY, dine_in: SAMPLE_BILL_DINE_IN };

  // The same orders as the kitchen sees them: the /kot payload carries only the
  // order, its table and its items (with the kitchen note per item).
  const toKot = (b) => ({
    id: b.id, display_id: b.display_id, created_at: b.created_at, time: b.time,
    table_number: b.table_number, table_name: b.table_name, type: b.type, notes: b.notes,
    items: b.order_items.map((it, i) => Object.assign({}, it, i === 0 ? { notes: "less spicy" } : {})),
    generated_at: b.generated_at,
  });
  const SAMPLE_KOTS = { delivery: toKot(SAMPLE_BILL), takeaway: toKot(SAMPLE_BILL_TAKEAWAY), dine_in: toKot(SAMPLE_BILL_DINE_IN) };

  return {
    VERSION, SIZES, ALIGNS, BLOCK_TYPES, QR_SOURCES, QR_SIZES, IMAGE_WIDTHS, ORDER_TYPES, ITEM_COLUMN_KEYS,
    FIELDS, ITEM_FIELDS, WHEN_FIELDS, TYPE_LABELS, DEFAULT_COLUMNS,
    DEFAULT_TEMPLATE, DEFAULT_KOT_TEMPLATE, SAMPLE_BILL, SAMPLE_BILLS, SAMPLE_KOTS,
    sanitizeForPrinter, to12Hour, generatedStamp, orderTypeKey, hasValue, evalWhen,
    parseMarkup, resolveBill, fitLines, physToEscPos, physToHtml, escposQr, qrModule, qrGeometry, qrModulesFor,
    normalizeTemplate, newBlock, summarizeBlock, uid,
  };
});
