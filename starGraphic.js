// Star Graphic raster for Star TSP100 / TSP143 printers.
//
// These printers have no fonts and silently drop ESC/POS: Windows says the job
// printed and no paper comes out. In raster mode every receipt this app makes
// is already pictures — GS v 0 bands, ESC a alignment, LF feeds and a GS V /
// ESC d cut — so for a Star printer that finished job is replayed here onto
// rows of the paper and sent as Star Graphic commands instead
// ("STAR Graphic Mode Command Specifications" Rev. 2.31). The same encoding
// as the Android app's StarGraphic.encode (lib/services/star_graphic.dart).
//
// Text in the job (only the ESC/POS text mode makes any) is skipped: a Star
// printer cannot print it, which is why a Star printer always prints raster.

"use strict";

const LINE_DOTS = 24; // one LF of the 12x24 font

function escStarR(cmd, n) {
  const out = [0x1b, 0x2a, 0x72, ...Buffer.from(cmd, "latin1")];
  if (n !== undefined) out.push(...Buffer.from(String(n), "latin1"), 0x00);
  return out;
}

// The pictures in an ESC/POS raster job as pages of 1-bit rows, widthDots wide
// (each row ceil(widthDots / 8) bytes, MSB leftmost), a page per cut.
function escPosToPages(buf, widthDots) {
  const bpr = Math.ceil(widthDots / 8);
  const pages = [];
  let rows = [];
  let align = 0; // ESC a: 0 left, 1 centre, 2 right
  const blank = (n) => {
    for (let i = 0; i < n; i++) rows.push(Buffer.alloc(bpr));
  };
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      // GS v 0 m xL xH yL yH d1...dk
      const w = buf[i + 4] | (buf[i + 5] << 8); // bytes per row
      const h = buf[i + 6] | (buf[i + 7] << 8);
      const data = i + 8;
      const srcDots = w * 8;
      const shift = align === 1 ? Math.max(0, (widthDots - srcDots) >> 1)
        : align === 2 ? Math.max(0, widthDots - srcDots) : 0;
      for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(bpr);
        for (let x = 0; x < srcDots && x + shift < widthDots; x++) {
          const byte = buf[data + y * w + (x >> 3)];
          if (byte & (0x80 >> (x & 7))) {
            const dx = x + shift;
            row[dx >> 3] |= 0x80 >> (dx & 7);
          }
        }
        rows.push(row);
      }
      i = data + w * h;
    } else if (b === 0x1b && buf[i + 1] === 0x61) {
      const n = buf[i + 2];
      align = n === 1 || n === 0x31 ? 1 : n === 2 || n === 0x32 ? 2 : 0;
      i += 3;
    } else if (b === 0x1b && buf[i + 1] === 0x40) {
      align = 0;
      i += 2;
    } else if (b === 0x1b && buf[i + 1] === 0x64) {
      // ESC d n: feed n lines (also the "star" cut command's bytes, ESC d 2 —
      // harmless as a feed: the job's end is cut anyway).
      blank(buf[i + 2] * LINE_DOTS);
      i += 3;
    } else if (b === 0x1d && buf[i + 1] === 0x56) {
      // GS V m [n]: cut
      const m = buf[i + 2];
      pages.push(rows);
      rows = [];
      i += m === 0x41 || m === 0x42 || m === 65 || m === 66 ? 4 : 3;
    } else if (b === 0x0a) {
      blank(LINE_DOTS);
      i += 1;
    } else {
      i += 1; // text or a command a picture-only printer has no use for
    }
  }
  pages.push(rows);
  return pages;
}

// Star Graphic commands for pages of rows. Blank rows travel as a vertical
// move and each row only as far as its last black dot; a page's own trailing
// blank rows (the job's feed before its cut) are dropped, because the printer
// feeds to its cutter itself.
function encode(pages, cutLast = true) {
  const out = [...escStarR("R"), ...escStarR("A"), ...escStarR("P", "0")];
  const inked = pages.filter((rows) => rows.some((r) => r.some((x) => x !== 0)));
  inked.forEach((rows, idx) => {
    const last = idx === inked.length - 1;
    out.push(...escStarR("E", last && !cutLast ? "2" : "9"));
    let end = rows.length;
    while (end > 0 && rows[end - 1].every((x) => x === 0)) end--;
    let blankRun = 0;
    for (let r = 0; r < end; r++) {
      const row = rows[r];
      let k = row.length;
      while (k > 0 && row[k - 1] === 0) k--;
      if (k === 0) {
        blankRun++;
        continue;
      }
      if (blankRun > 0) {
        out.push(...escStarR("Y", blankRun));
        blankRun = 0;
      }
      out.push(0x62, k & 0xff, (k >> 8) & 0xff, ...row.subarray(0, k));
    }
    out.push(0x1b, 0x0c, 0x04); // ESC FF EOT: print the page, run EOT mode
  });
  out.push(...escStarR("B"));
  return Buffer.from(out);
}

// A finished ESC/POS raster job as the same receipt in Star Graphic commands.
function fromEscPos(buf, widthDots) {
  return encode(escPosToPages(Buffer.from(buf), widthDots));
}

module.exports = { fromEscPos, escPosToPages, encode };
