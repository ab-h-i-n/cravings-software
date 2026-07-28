// Arabic thermal-printer code-page probe.
//
// Thermal printers can only render Arabic if (a) they have an Arabic code page
// in firmware and (b) we select it with the right `ESC t n` value and send the
// matching byte encoding. That `n` is printer-specific and undocumented for most
// cheap 80mm units, so this script prints the SAME Arabic word under a batch of
// candidate (n, encoding) combinations, each labeled. Whichever line comes out
// as correct, connected Arabic tells us the value to lock into main.js.
//
// Usage (on the machine with the thermal printer set as the Windows DEFAULT):
//   node arabic-probe.js         -> builds the payload AND prints it
//   node arabic-probe.js --dry   -> only builds temp_arabic_probe.bin (no print)
//
// It reuses print-raw.exe, i.e. the exact raw path the real app prints through.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const iconv = require("iconv-lite");

const ESC = "\x1B";
const GS = "\x1D";
const LF = "\x0A";
const INIT = ESC + "@";
const setPage = (n) => ESC + "t" + String.fromCharCode(n);
const ASCII_PAGE = setPage(0); // PC437 – back to plain ASCII
const BOLD_ON = ESC + "E" + "\x01";
const BOLD_OFF = ESC + "E" + "\x00";
const ALIGN_LEFT = ESC + "a" + "\x00";
const ALIGN_CENTER = ESC + "a" + "\x01";
const CUT_FULL = GS + "V" + "\x42" + "\x00";

// The real item text that was being stripped ("Chicken Burger").
const WORD = "برجر دجاج";

// Candidate (ESC t n, iconv encoding) pairs seen across common ESC/POS printers.
// n is the code-page slot; enc must match what that slot expects.
const CANDIDATES = [
  { n: 22, enc: "cp864" },   // PC864 Arabic – very common on cheap 80mm units
  { n: 37, enc: "cp864" },   // PC864 (alt slot on some firmwares)
  { n: 33, enc: "cp864" },   // PC864 (alt slot)
  { n: 32, enc: "cp720" },   // PC720 Arabic (DOS)
  { n: 33, enc: "cp1256" },  // Windows-1256
  { n: 50, enc: "cp1256" },  // WPC1256 (Epson-style slot)
  { n: 62, enc: "cp1256" },  // Windows-1256 (alt slot)
  { n: 22, enc: "cp1256" },  // in case slot 22 is CP1256 on this unit
];

const chunks = [];
const ascii = (s) => chunks.push(Buffer.from(s, "ascii"));
const bytes = (b) => chunks.push(b);
const encodeOr = (word, enc) => {
  try {
    if (!iconv.encodingExists(enc)) return null;
    return iconv.encode(word, enc);
  } catch {
    return null;
  }
};

ascii(INIT);
ascii(ALIGN_CENTER + BOLD_ON + "ARABIC CODE PAGE PROBE" + LF + BOLD_OFF);
ascii("target word = chicken burger" + LF);
ascii("pick the line that reads correctly" + LF);
ascii("-".repeat(32) + LF);
ascii(ALIGN_LEFT);

CANDIDATES.forEach((c, i) => {
  ascii(ASCII_PAGE);
  ascii(`${i + 1}) n=${c.n} ${c.enc}: `);
  const enc = encodeOr(WORD, c.enc);
  if (enc) {
    ascii(setPage(c.n));
    bytes(enc);
  } else {
    ascii("[encoding unavailable]");
  }
  ascii(ASCII_PAGE + LF);
});

// References with NO page selection, to show the "unhandled" baselines.
ascii(ASCII_PAGE + LF + "refs (no page select):" + LF);
const utf8 = Buffer.from(WORD, "utf8");
ascii("utf8 : ");
bytes(utf8);
ascii(LF);
const cp1256 = encodeOr(WORD, "cp1256");
ascii("1256 : ");
if (cp1256) bytes(cp1256);
ascii(LF);
const cp864 = encodeOr(WORD, "cp864");
ascii("864  : ");
if (cp864) bytes(cp864);
ascii(LF);

ascii(ASCII_PAGE);
ascii(LF + LF + LF + CUT_FULL);

const payload = Buffer.concat(chunks);
const filePath = path.join(__dirname, "temp_arabic_probe.bin");
fs.writeFileSync(filePath, payload);
console.log(`Wrote ${payload.length} bytes -> ${filePath}`);

if (process.argv.includes("--dry")) {
  console.log("Dry run: skipping print. Inspect the .bin or re-run without --dry to print.");
  process.exit(0);
}

const exePath = path.join(__dirname, "print-raw.exe");
execFile(exePath, [filePath], (err, stdout, stderr) => {
  if (err) {
    console.error("print-raw error:", err.message);
    if (stderr) console.error(stderr);
    return;
  }
  console.log("print-raw:", (stdout || "").trim());
});
