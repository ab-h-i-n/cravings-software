// English -> Arabic bill/KOT label map for the "Full Arabic" print option.
// Applied to the rendered receipt page (in the hidden print window) just before it is
// rasterized, so the static labels print in Arabic. Longer phrases first so they win
// over shorter substrings (e.g. "Order Details:" before "Order :").
const AR_LABELS = [
  ["Order Details:", "تفاصيل الطلب:"],
  ["Items Ordered", "الأصناف المطلوبة"],
  ["Pay Via:", "طريقة الدفع:"],
  ["Thank you for your visit!", "شكراً لزيارتكم!"],
  ["Thank you for your visit", "شكراً لزيارتكم"],
  ["Powered By Menuthere", "مدعوم من Menuthere"],
  ["Order :", "رقم الطلب :"],
  ["Order:", "رقم الطلب:"],
  ["Tel:", "هاتف:"],
  ["Date:", "التاريخ:"],
  ["Type:", "النوع:"],
  ["Time:", "الوقت:"],
  ["Subtotal:", "المجموع الفرعي:"],
  ["TOTAL:", "الإجمالي:"],
  ["Total:", "الإجمالي:"],
];

// A self-contained JS expression (as a string) to run in the page via executeJavaScript.
// Walks text nodes under #printable-content and swaps the English labels for Arabic.
function arabicLabelScript() {
  return `(() => {
    const root = document.getElementById('printable-content') || document.body;
    const map = ${JSON.stringify(AR_LABELS)};
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
    for (const n of nodes) {
      let t = n.nodeValue; const o = t;
      for (const pair of map) { if (t.indexOf(pair[0]) !== -1) t = t.split(pair[0]).join(pair[1]); }
      if (t !== o) n.nodeValue = t;
    }
    return true;
  })()`;
}

module.exports = { AR_LABELS, arabicLabelScript };
