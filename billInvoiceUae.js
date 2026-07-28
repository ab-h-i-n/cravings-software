// Third bill layout: a UAE-style "Simplified Tax Invoice" (classic thermal-receipt look
// with dashed separators). Rendered from the order JSON (the "Bill Contents JSON" the web
// page logs), loaded into the hidden print window, and rasterized like any other receipt.
//
// Difference from the ZATCA "invoice" layout: the VAT and Net Amount lines are ALWAYS
// bilingual (Arabic / English) regardless of the Full Arabic setting — matching the UAE
// FTA simplified tax-invoice format. There is no token-number or waiter line.

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => (Number(n) || 0).toFixed(2);

// order.type in the bill JSON is an English display string ("Delivery", "Takeaway",
// " Table 1", ...). Keep it English unless Full Arabic is on (then prefix the Arabic).
function typeLabel(t, fullArabic) {
  const s = String(t || "").trim();
  const pick = (ar, en) => (fullArabic ? `${ar} - ${en}` : en);
  if (/delivery/i.test(s)) return pick("توصيل", "Delivery");
  if (/takeaway/i.test(s)) return pick("سفري", "Take Away");
  if (/parcel/i.test(s)) return fullArabic ? "سفري - " + s : s;
  if (/table/i.test(s)) return fullArabic ? "طاولة - " + s : s;
  return s;
}

async function buildUaeInvoiceHtml(order, srcWidth, fullArabic = false) {
  const c = order.calculations || {};
  const vatPct = c.gst_percentage != null ? c.gst_percentage : 5;
  const vat = Number(c.gst_amount) || 0;
  const grand = Number(c.grand_total) || 0;
  // Item prices are VAT-inclusive (what the customer pays), so the pre-VAT amount is
  // grand - vat, and the VAT is extracted from the total (matches the reference receipt:
  // items 7+3 = 10.00 total -> 9.52 before VAT + 0.48 VAT @ 5%).
  const beforeVat = Math.max(0, grand - vat);
  const discount = Number(c.discount_amount) || 0;
  const invoiceNo = (Number(order.display_id) > 0 ? order.display_id : String(order.id || "").slice(0, 8)).toString();
  const dateTime = `${order.created_at || ""} ${order.time || ""}`.trim();
  const typeText = esc(typeLabel(order.type, fullArabic));

  // Rows: "<qty>-<name>" on the left, unit price, then the line total (like "3-PARATA 1.00 3.00").
  const rows = (order.order_items || []).map((it) => {
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    return `<tr>
      <td class="desc">${qty}-${esc(it.name)}</td>
      <td class="n">${money(price)}</td>
      <td class="n">${money(qty * price)}</td>
    </tr>`;
  }).join("");

  // Any extra charges (delivery, parcel, ...) listed above the tax summary.
  const charges = (order.extra_charges || [])
    .filter((ch) => Number(ch.price) !== 0)
    .map((ch) => `<div class="kv"><span class="l">${esc(ch.name)}</span><span class="n">${money(ch.price)}</span></div>`)
    .join("");

  // VAT and Net Amount labels are ALWAYS bilingual, like the reference invoice.
  const vatLabel = `الضريبة / VAT @ ${vatPct}%`;
  const netLabel = `اجمالى / Net Amount`;

  return `<!DOCTYPE html>
<html lang="ar"><head><meta charset="UTF-8"><style>
  html,body{margin:0;padding:0;background:#fff;}
  #printable-content{ width:${srcWidth}px; box-sizing:border-box; padding:6px 8px;
    font-family:'Segoe UI',Tahoma,Arial,sans-serif; color:#000; font-size:12px; line-height:1.4; }
  .c{text-align:center;} .b{font-weight:bold;}
  .store{font-size:18px;font-weight:bold;line-height:1.15;text-transform:uppercase;}
  .sub{font-size:11px;}
  .mono{font-family:monospace;}
  .title{font-size:14px;font-weight:bold;margin-top:5px;}
  .otype{font-size:13px;font-weight:bold;}
  .info{font-size:11px;margin-top:4px;}
  .info div{padding:1px 0;}
  .sep{border-top:1px dashed #000;margin:5px 0;}
  .sep2{border-top:3px double #000;margin:5px 0;}
  table.items{ width:100%; border-collapse:collapse; table-layout:fixed; }
  table.items th,table.items td{ padding:2px 2px; font-size:11px; vertical-align:top; word-break:break-word; }
  table.items th{ font-weight:bold; border-top:1px dashed #000; border-bottom:1px dashed #000; }
  th.cdesc,td.desc{ text-align:left; }
  th.cn,td.n{ text-align:right; font-family:monospace; }
  .cprice{ width:22%; } .ctot{ width:22%; }
  .kv{ display:flex; justify-content:space-between; align-items:center; gap:8px; padding:2px 2px; font-size:12px; }
  .kv .l{ flex:1; min-width:0; }
  .kv .n{ flex-shrink:0; font-family:monospace; text-align:right; min-width:56px; }
  .kv.big{ font-weight:bold; font-size:14px; }
  .thanks{ text-align:center; font-weight:bold; margin-top:6px; }
</style></head>
<body><div id="printable-content">
  <div class="c store">${esc(order.store_name || "")}</div>
  ${order.address ? `<div class="c sub">${esc(order.address)}</div>` : ""}
  ${order.phone ? `<div class="c sub">Tel: <span class="mono">${esc(order.phone)}</span></div>` : ""}
  ${order.trn ? `<div class="c sub">TRN : <span class="mono">${esc(order.trn)}</span></div>`
             : (order.gst_no ? `<div class="c sub">Tax No : <span class="mono">${esc(order.gst_no)}</span></div>` : "")}
  <div class="c title">${fullArabic ? "فاتورة ضريبية / Tax Invoice" : "Tax Invoice"}</div>
  ${typeText ? `<div class="c otype">${typeText}</div>` : ""}
  <div class="info">
    <div>Bill No: <span class="mono">${esc(invoiceNo)}</span></div>
    ${dateTime ? `<div>Date: <span class="mono">${esc(dateTime)}</span></div>` : ""}
  </div>
  <table class="items">
    <tr><th class="cdesc">Item's</th><th class="cn cprice">Price</th><th class="cn ctot">Total</th></tr>
    ${rows}
  </table>
  <div class="sep2"></div>
  ${charges}
  ${discount > 0 ? `<div class="kv"><span class="l">Discount</span><span class="n">-${money(discount)}</span></div>` : ""}
  <div class="kv"><span class="l">Total Before VAT</span><span class="n">${money(beforeVat)}</span></div>
  <div class="kv"><span class="l">${vatLabel}</span><span class="n">${money(vat)}</span></div>
  <div class="sep"></div>
  <div class="kv big"><span class="l">${netLabel}</span><span class="n">${money(grand)}</span></div>
  <div class="thanks">*** THANK YOU ***</div>
</div></body></html>`;
}

module.exports = { buildUaeInvoiceHtml };
