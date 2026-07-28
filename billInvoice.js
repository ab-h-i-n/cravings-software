// Second bill layout: a bilingual (Arabic/English) ZATCA-style "Simplified Tax Invoice".
// Rendered from the order JSON (the "Bill Contents JSON" the page logs), loaded into the
// hidden print window, and rasterized like any other receipt.

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => (Number(n) || 0).toFixed(2);

// order.type in the bill JSON is an English display string ("Delivery", " Table 1", ...).
function typeLabel(t, fullArabic) {
  const s = String(t || "").trim();
  const pick = (ar, en) => (fullArabic ? `${ar} - ${en}` : en);
  if (/delivery/i.test(s)) return pick("توصيل", "Delivery");
  if (/takeaway/i.test(s)) return pick("سفري", "Takeaway");
  if (/parcel/i.test(s)) return fullArabic ? "سفري - " + s : s;
  if (/table/i.test(s)) return fullArabic ? "طاولة - " + s : s;
  return s;
}

async function buildInvoiceHtml(order, srcWidth, fullArabic = false) {
  const c = order.calculations || {};
  const vatPct = c.gst_percentage != null ? c.gst_percentage : 15;
  const vat = Number(c.gst_amount) || 0;
  const grand = Number(c.grand_total) || 0;
  const productValue = Math.max(0, grand - vat);
  const discount = Number(c.discount_amount) || 0;
  const invoiceNo = (Number(order.display_id) > 0 ? order.display_id : String(order.id || "").slice(0, 8));
  const orderNo = (Number(order.display_id) > 0 ? order.display_id : String(order.id || "").slice(0, 4)).toString();
  const dateTime = `${order.created_at || ""} ${order.time || ""}`.trim();
  const typeText = esc(typeLabel(order.type, fullArabic));
  const payMethod = esc((order.payment_method || "cash")).toUpperCase();
  const customer = esc(order.customer_name || "CASH CUSTOMER");

  // Columns are laid out LTR as Total | Price | Qty | Description so Description ends up
  // on the right (like the Arabic invoice) while the capture pipeline stays LTR (RTL doc
  // direction breaks the zoom/capture geometry).
  const rows = (order.order_items || []).map((it) => {
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    return `<tr>
      <td class="n">${money(qty * price)}</td>
      <td class="n">${money(price)}</td>
      <td class="n">${qty}<div class="each">EACH</div></td>
      <td class="desc">${esc(it.name)}</td>
    </tr>`;
  }).join("");

  const kv = (en, ar, val, bold) => {
    const label = fullArabic ? `<span class="en">${en}</span> ${ar}` : en;
    return `<div class="kv"><span class="l">${label}</span><span class="n${bold ? " b" : ""}">${val}</span></div>`;
  };
  const th = (en, ar, cls) => `<th class="${cls || ""}">${fullArabic ? `${ar}<br>${en}` : en}</th>`;

  return `<!DOCTYPE html>
<html lang="ar"><head><meta charset="UTF-8"><style>
  html,body{margin:0;padding:0;background:#fff;}
  #printable-content{ width:${srcWidth}px; box-sizing:border-box; padding:6px 8px;
    font-family:'Segoe UI',Tahoma,Arial,sans-serif; color:#000; font-size:12px; line-height:1.35; }
  .c{text-align:center;} .b{font-weight:bold;}
  .store{font-size:17px;font-weight:bold;}
  .sub{font-size:11px;}
  .mono{font-family:monospace;}
  .orderbox{ border:2px solid #000; padding:4px 6px; text-align:center; font-weight:bold;
    font-size:15px; margin:7px auto; width:75%; box-sizing:border-box; }
  .head2{ display:flex; justify-content:space-between; gap:8px; border-bottom:1px solid #000;
    padding:4px 0; margin-bottom:4px; font-size:11px; }
  .head2 .r{ text-align:right; }
  table.items{ width:100%; border-collapse:collapse; margin:2px 0; table-layout:fixed; }
  table.items th, table.items td{ border:1px solid #000; padding:3px 3px; font-size:11px;
    vertical-align:top; word-break:break-word; }
  table.items th{ text-align:center; font-weight:bold; }
  .ctot,.cprice{ width:20%; } .cqty{ width:16%; }
  td.n{ text-align:center; font-family:monospace; }
  td.desc{ text-align:right; }
  .each{ font-size:9px; }
  .kv{ display:flex; justify-content:space-between; align-items:center; gap:8px;
    border-bottom:1px solid #000; padding:4px 2px; }
  .kv .l{ flex:1; min-width:0; font-weight:bold; }
  .kv .en{ font-size:10px; font-weight:normal; }
  .kv .n{ flex-shrink:0; font-family:monospace; text-align:right; min-width:56px; }
  .pay{ border:1px solid #000; margin-top:6px; }
  .pay .kv{ border-bottom:1px solid #000; } .pay .kv:last-child{ border-bottom:none; }
  .cust{ text-align:center; margin-top:6px; letter-spacing:1px; }
  .thanks{ text-align:center; font-weight:bold; margin-top:5px; }
</style></head>
<body><div id="printable-content">
  <div class="c store">${esc(order.store_name || "")}</div>
  <div class="c sub">${esc(order.address || "")}</div>
  ${order.gst_no ? `<div class="c sub">${fullArabic ? "رقم الضريبي" : "Tax No"} : <span class="mono">${esc(order.gst_no)}</span></div>` : ""}
  ${order.trn ? `<div class="c sub">TRN : <span class="mono">${esc(order.trn)}</span></div>` : ""}
  ${order.phone ? `<div class="c sub">${fullArabic ? "رقم الجوال" : "Mobile"} : <span class="mono">${esc(order.phone)}</span></div>` : ""}
  ${fullArabic ? `<div class="c b" style="margin-top:5px;">فاتورة ضريبية مبسطة</div><div class="c b">Simplified Tax Invoice</div>`
              : `<div class="c b" style="margin-top:5px;">Simplified Tax Invoice</div>`}
  <div class="orderbox">${fullArabic ? "طلب" : "Order"} #&nbsp;&nbsp;<span class="mono">${esc(orderNo)}</span></div>
  <div class="head2">
    <span>${fullArabic ? "ر الفاتورة" : "Invoice #"}<br><span class="mono">${esc(invoiceNo)}</span></span>
    <span class="r">${typeText}<br><span class="mono">${esc(dateTime)}</span></span>
  </div>
  <table class="items">
    <tr>${th("Total", "الإجمالي", "ctot")}${th("Price", "سعر", "cprice")}${th("Qty", "الكمية", "cqty")}${th("Description", "الوصف")}</tr>
    ${rows}
  </table>
  ${kv("Disc (%)", "خصم", money(discount))}
  ${kv("Product Value Excl.VAT", "قيمة المنتجات", money(productValue))}
  ${kv(`VAT(${vatPct}%)`, "ضريبة القيمة المضافة", money(vat))}
  ${kv("Net Total", "صافي", money(grand), true)}
  <div class="pay">
    ${kv(payMethod, "المبلغ المدفوع", money(grand))}
  </div>
  <div class="cust">${customer}</div>
  <div class="thanks">*** THANK YOU ***</div>
</div></body></html>`;
}

module.exports = { buildInvoiceHtml };
