# Custom bill & KOT layouts — implementation spec

How a partner's customised ESC/POS receipt works, written so the **Android printer
app** can print (and, if wanted, edit) the same layouts as the Windows desktop app.

The reference implementation is `billTemplate.js` in this repository
(`cravings-software`). It is ~1,300 lines of dependency-free JavaScript; porting it
to Kotlin is mostly mechanical. Everything below states the *rules*, so the port can
be verified against the desktop output rather than transliterated line by line.

**Contents**

1. [What the feature is](#1-what-the-feature-is)
2. [Where a layout lives](#2-where-a-layout-lives)
3. [The template format](#3-the-template-format)
4. [Fields](#4-fields)
5. [Inline markup](#5-inline-markup)
6. [Stage 1 — resolve](#6-stage-1--resolve-template--order--logical-lines)
7. [Stage 2 — fit](#7-stage-2--fit-logical--physical-lines)
8. [Stage 3 — emit ESC/POS](#8-stage-3--emit-escpos)
9. [Images](#9-images)
10. [QR codes](#10-qr-codes)
11. [The built-in layouts](#11-the-built-in-layouts)
12. [Editor UI (if you build one)](#12-editor-ui-if-you-build-one)
13. [Porting checklist & test plan](#13-porting-checklist--test-plan)

---

## 1. What the feature is

A partner can redesign their thermal bill and kitchen ticket line by line: text,
fields, per-word bold/size, separators, blank lines, logos, QR codes, an items
table, and sections that appear only for certain orders.

The design is stored as JSON on the partner's account, so it follows them to every
device and the Menuthere team can edit it for them. Any app that prints receipts
renders the same JSON and produces the same paper.

Three hard rules the desktop app follows; the Android app must too:

1. **Opt-in per device.** A saved layout prints **only** where the operator has
   turned it on. Off by default on every install. Off ⇒ print exactly what you
   print today.
2. **Never fail a print.** If a layout is missing, malformed, or throws, fall back
   to the built-in receipt. A bad layout must never cost a partner a bill.
3. **The built-in layout is the current receipt.** `DEFAULT_TEMPLATE` /
   `DEFAULT_KOT_TEMPLATE` are the existing hard-coded receipts expressed as blocks.
   Rendering them must produce byte-equivalent output to the old code path (see
   §13); that is what makes "reset to default" and the first edit safe.

---

## 2. Where a layout lives

### Database (already deployed)

| Column | Type | Holds |
|---|---|---|
| `partners.bill_template` | `jsonb`, nullable | the bill layout, `null` = never customised |
| `partners.kot_template` | `jsonb`, nullable | the kitchen-ticket layout |

### In the print payload (the path Android already uses)

The Android app scrapes the JSON that `menuthere.com/bill/<id>` and `/kot/<id>`
log to the console. Both payloads now carry the layout, **additively** — every key
that existed before is unchanged and still in place:

```jsonc
// "Bill Contents JSON:" …
{
  "id": "…", "display_id": "42-06/09/2026", "order_no": "42",
  "store_name": "…", "order_items": [...], "calculations": {...},
  "bill_template": { "v": 1, "paper": {...}, "blocks": [...] },  // null when not customised
  "store_logo_url": "https://…"        // the uploaded logo, whatever the "print logo" switch says
}

// "KOT Contents JSON:" …
{ "id": "…", "items": [...], "kot_template": { … } }
```

**This is the only integration Android needs to print custom layouts.** Read
`bill_template` / `kot_template` from the payload you already parse; if it is
non-null and the device opted in, render it instead of the built-in receipt.

### Sync API (only if Android also *edits* layouts)

`GET|PUT https://menuthere.com/api/print/bill-template`, authenticated by the
partner's session cookie (the desktop app sends the cookies of its own signed-in
web view; a superadmin signed in *as* a partner therefore edits that partner's
layout).

```jsonc
// GET →
{ "ok": true,
  "template": {...} | null,      // bill
  "kotTemplate": {...} | null,   // KOT
  "updatedAt": "2026-09-07T…",
  "logoUrl": "https://…" | null,
  "storeName": "OREO DEMO",
  "store": { "store_name": "…", "address": "…", "phone": "…", "gst_no": "…",
             "fssai_licence_no": "…", "trn": "…", "currency": "₹", "country": "India",
             "upi_id": "…", "show_payment_qr": false, "bill_show_detail_qr": false,
             "logo_url": "…" } }

// PUT { "template": {...} } or { "kotTemplate": {...} } or both →
{ "ok": true, "updatedAt": "…", "logoUrl": …, "store": {...} }
```

Errors: `401` not signed in, `403` session is not a partner, `400` with a reason
when the layout fails validation, `404` partner not found.

The `store` block exists so an editor can preview the partner's real header
(name/address/tax numbers) without a live order.

### Local cache and precedence

The desktop keeps a local copy so it works offline. Print-time precedence:

```
layout in this print payload  →  last layout saved/synced on this device  →  built-in receipt
```

A payload layout also refreshes the local copy, unless a local edit is still
waiting to be pushed (that one is newer).

---

## 3. The template format

```jsonc
{
  "v": 1,
  "paper": { "feedLines": 3, "cut": true },   // blank lines before the cut; whether to cut
  "blocks": [ /* Block[] */ ]
}
```

Ignore/strip anything you don't recognise; a template whose `v` is not 1 is
"unreadable" ⇒ fall back to the built-in receipt.

> Historical: some layouts may carry `perType: true` and
> `variants: { delivery|takeaway|dine_in: { blocks: [...] } }` from a
> short-lived feature. If present, use `variants.delivery.blocks` as the block
> list and drop the rest. New layouts never write these.

### Common block fields

| Field | Meaning |
|---|---|
| `id` | string, unique within the template (editor bookkeeping; ignore when printing) |
| `type` | one of `text`, `row`, `rule`, `space`, `image`, `qr`, `items`, `charges`, `group` |
| `hidden` | `true` ⇒ never prints (kept in the layout) |
| `when` | condition, see below; absent ⇒ always prints |

### `when`

```jsonc
{ "orderType": ["delivery", "takeaway", "dine_in"] }   // any of these kinds
{ "has": "<key>" }                                     // that thing has a value
{ "missing": "<key>" }                                 // it does not
```

`has`/`missing` keys — composite first, then any field key from §4:

| Key | True when |
|---|---|
| `customer` | customer name **or** phone **or** delivery address is set |
| `rider` | `delivery_boy.name` or `.phone` is set |
| `extra_charges` | the order has at least one extra charge |
| `items` | the order has at least one item |
| `delivery_location` | `delivery_location.google_maps_link` is set |
| `upi` | `payment_upi_string` is set |
| `bill_detail` | `bill_detail_url` is set |
| `logo` | `store_logo_url` or `bill_logo_url` is set |
| anything else | the field of that key resolves to a non-empty string |

Order-type detection, from the payload's `type` string (case-insensitive
substring, in this order):

```
contains "delivery"                                → delivery
contains "parcel"|"takeaway"|"take away"|"pickup"  → takeaway
contains "table"|"dine"                            → dine_in
otherwise                                          → unknown (orderType conditions never match)
```

### Style

Any block that draws text may carry `style`, and text can also be styled
per-word by inline tags (§5).

```jsonc
{ "bold": true, "underline": true, "invert": true,
  "size": "normal" | "tall" | "wide" | "big",     // tall = 2× height, wide = 2× width, big = both
  "align": "left" | "center" | "right" }
```

### Block types

#### `text`
```jsonc
{ "type": "text", "text": "Tel: {phone}", "style": {...},
  "hideIfEmpty": true,   // default true — see §6
  "wrap": true }         // default true; false = emit one line, let the printer break it
```
**A newline inside `text` is a line break, and an empty line prints as a blank
line.** One block can hold several lines with gaps.

#### `row` — 2 to 4 cells on one line
```jsonc
{ "type": "row", "style": {...}, "hideIfEmpty": true,
  "cells": [ { "text": "TOTAL:", "align": "left",  "width": "flex" },
             { "text": "{currency} {grand_total}", "align": "right" } ] }
```
`width`: `"flex"` (fills the remaining columns and wraps), a number (fixed
columns, truncated to fit), or absent (as wide as its own text). Exactly one cell
flexes; if none is marked, the **first** cell flexes. Newlines in a cell are
spaces.

#### `rule`
```jsonc
{ "type": "rule", "char": "-" }   // char may be several characters; default "-"
```
Repeat `char` to exactly `cols` columns (`repeat(ceil(cols / char.length))`, then
cut to `cols`).

#### `space`
```jsonc
{ "type": "space", "lines": 1 }   // 1..10
```

#### `image`
```jsonc
{ "type": "image", "src": "logo" | "https://…" | "data:image/png;base64,…",
  "width": 25 | 50 | 75 | 100,    // percent of paper width; default 50
  "align": "center" }
```
`"logo"` means the store's uploaded logo: `store_logo_url` first, then
`bill_logo_url`. See §9.

#### `qr`
```jsonc
{ "type": "qr",
  "source": "bill_detail" | "upi" | "delivery_location" | "custom",
  "value": "…",                 // custom only; fields allowed
  "size": 10..100 | "s"|"m"|"l",
  "caption": "Scan to Pay",     // printed above, centred
  "captionBelow": "{currency} {grand_total}" }
```
Payload sources: `bill_detail_url`, `payment_upi_string`,
`delivery_location.google_maps_link`. Empty source ⇒ the whole block prints
nothing (caption included). See §10.

#### `items` — one row per order item
```jsonc
{ "type": "items",
  "layout": "inline",                    // or "columns"
  "format": "{qty} x {name}",            // inline only; item fields allowed
  "showAmount": true,                    // inline only; false = no amount column (kitchen ticket)
  "columns": [ { "key": "qty", "label": "Qty", "width": 4, "align": "left" },
               { "key": "name",   "label": "Item",   "width": "flex" },
               { "key": "price",  "label": "Price",  "width": 8,  "align": "right" },
               { "key": "amount", "label": "Amount", "width": 9,  "align": "right" } ],
  "header": true, "headerStyle": { "bold": true },
  "rowStyle": {...}, "nameStyle": { "bold": true },
  "showNotes": false, "showCategory": false,
  "separator": false,                    // a rule between items
  "gapAfter": false }                    // a blank line after each item
```
Column keys are `qty | name | price | amount`; the `name` column always flexes.
If `columns` is missing or empty, use the four defaults above. If no `name`
column is listed, insert the default one at position 1.

#### `charges` — one row per extra charge
```jsonc
{ "type": "charges", "style": {...} }
```
Renders `charge.name` left, `charge.price` (2 decimals) right. Nothing when the
order has no extra charges.

#### `group` — a section, **one level deep**
```jsonc
{ "type": "group", "label": "Customer details", "when": { "has": "customer" },
  "blocks": [ /* Block[], no nested groups */ ] }
```
The group's `when`/`hidden` gates all its children.

### Validation (what the server enforces, mirror it locally)

Max 300 blocks, 2,000 characters per string, 120 KB per embedded image,
200 KB for the whole template JSON; `image.src` must be `"logo"`, an `https://`
URL, or a `data:image/(png|jpeg|jpg|gif|webp|bmp);base64,` URI; no nested groups.

---

## 4. Fields

`{key}` inside text, cells, `format`, `value` and captions is replaced from the
order. **An unknown key is left visible as literal text** (`{nope}` prints as
`{nope}`) — that is deliberate, so a typo is obvious on paper.

### Order fields

| Key | Value (from the payload) |
|---|---|
| `store_name` | `store_name`, or `"Restaurant"` when empty |
| `address` | `address` |
| `phone` | `phone` |
| `tax_no` | `gst_no` |
| `tax_label` | `"VAT"` when `country == "United Arab Emirates"`, else `"GST"` — **label-only** |
| `trn` | `trn` |
| `fssai` | `fssai_licence_no` |
| `order_id` | first 8 characters of `id` (falls back to `display_id`) |
| `order_no` | the bare invoice number: `order_no` if present, else `display_id` with a trailing `-D/M/YYYY` stripped; empty when `display_id` is just the short id |
| `date` | `created_at` (already formatted by the web page) |
| `time` | `time`, converted to 12-hour (see below) |
| `order_type` | `type` |
| `table` | `table_name`, else `"Table " + table_number`, else empty |
| `payment_method` | `payment_method` |
| `notes` | `notes` |
| `generated_at` | `generated_at`, else the device clock (see below) |
| `customer_name` | `customer_name` |
| `customer_phone` | `customer_phone` |
| `delivery_address` | `delivery_address` |
| `rider_name` | `delivery_boy.name` |
| `rider_phone` | `delivery_boy.phone` |
| `currency` | `currency` — **label-only** |
| `subtotal` | `calculations.subtotal`, 2 decimals |
| `discount` | `calculations.discount_amount` if > 0, else **empty** |
| `tax` | `calculations.gst_amount` if > 0, else **empty** |
| `tax_pct` | `calculations.gst_percentage`, empty when the tax is 0 |
| `charges_total` | sum of `extra_charges[].price` if > 0, else empty |
| `grand_total` | `calculations.grand_total`, 2 decimals |
| `item_count` | number of items, empty when none |
| `total_qty` | sum of quantities, empty when 0 |

**Label-only** fields (`currency`, `tax_label`) never count as content for
`hideIfEmpty` — a line holding only a currency symbol is still "empty".

### Item fields (inside an `items` block)

| Key | Value |
|---|---|
| `qty` | `quantity` |
| `name` | `name` |
| `price` | `price`, 2 decimals |
| `amount` | `quantity × price`, 2 decimals |
| `notes` | item note |
| `category` | category |

Items come from `order_items` (bill payload) or `items` (KOT payload).

### Two shared formatters

```
to12Hour("13:40")  -> "1:40 PM"      // "HH:MM" only; anything already carrying am/pm
                                     // or not matching passes through untouched
generatedStamp("") -> "07/09/2026, 4:16:31 PM"   // device clock, hand-formatted,
                                     // NOT toLocaleString (a 24-hour Windows install
                                     // printed 16:02 while the rest of the bill was 12-hour)
```

---

## 5. Inline markup

Six tags may appear inside any text: `<b>`, `<u>`, `<inv>`, `<big>`, `<wide>`,
`<tall>` and their closers. They nest; sizes use a stack (the innermost wins).
Anything else in angle brackets is literal text.

**Parse tags before substituting fields.** A customer named `<b>` must not be
able to restyle the bill.

Result: a list of *segments*, each carrying its own `bold`, `underline`,
`invert`, `size`, plus the block's `style` merged in (a block-level `bold` applies
to every segment; a block-level `size` applies where the segment has none).
Segments that end up empty are dropped.

---

## 6. Stage 1 — resolve (template + order → logical lines)

Walk the blocks in order, producing logical lines:

```jsonc
{ "t": "text",  "align": "center", "segs": [ {v, bold, underline, invert, size} ], "wrap": true }
{ "t": "row",   "cells": [ { "segs": [...], "align": "left", "width": "flex" | n | null } ] }
{ "t": "rule",  "ch": "-" }
{ "t": "feed",  "n": 1 }
{ "t": "qr",    "v": "https://…", "size": 30, "align": "center" }
{ "t": "image", "src": "…", "width": 50, "align": "center" }
{ "t": "cut" }
```

Rules:

- **Skip** a block when `hidden`, or when its `when` does not hold.
- **`hideIfEmpty`** (default on, `text` and `row` only): count the field tokens
  on the line, excluding label-only fields. If there is at least one and *all* of
  them resolved empty, skip the line. This is what makes
  `Discount: -{currency} {discount}` disappear on an order with no discount.
- **`text`** splits on newlines into one logical line each (empty ⇒ blank line).
- **`items`** emits per item: inline ⇒ a `row` of `[format, {amount}]`, or a plain
  `text` when `showAmount` is false; columns ⇒ an optional header row then a row
  per item. Then, per item: the note line `  (Note: …)` if `showNotes`, the
  category line if `showCategory`, a `rule` if `separator` (not after the last),
  a `feed` if `gapAfter`.
- **`qr`** emits: `feed 1`, the caption (if any) centred, the `qr` line, `feed 1`,
  then `captionBelow` (if any). Skips everything when the source is empty.
- **`group`** recurses into its children with the group's gating applied.
- Finally: **collapse consecutive identical rules into one** (two `-----` lines in
  a row print as one), then append `feed paper.feedLines` and, unless
  `paper.cut === false`, a `cut`.

Every text value is passed through the printer sanitiser as it is resolved:

```
₹ → "Rs."    € → "EUR"    £ → "GBP"    $ → "USD"    then drop everything non-ASCII
```

(Same rule the existing ESC/POS code uses. Non-ASCII scripts such as Arabic
cannot be printed as ESC/POS text at all; that is a raster-image path, out of
scope here.)

---

## 7. Stage 2 — fit (logical → physical lines)

`cols` = characters per line = **32 on 58 mm, 48 on 80 mm** (Font A, 12-dot
glyphs). A `wide` or `big` segment costs **2 columns per character**; everything
else costs 1.

- **`text`**: wrap at spaces to `cols` (unless `wrap: false`), then right-trim.
- **`rule`**: expand to exactly `cols` characters.
- **`feed n`**: `n` empty text lines.
- **`qr`, `image`, `cut`**: pass through untouched.
- **`row`**: see below.

### Wrapping

Split into space/non-space tokens, then greedily fill lines:

- Internal spacing is preserved when the line fits (`"Ph  : 98…"` keeps its gap).
- Spaces at a break are dropped; a wrapped line never starts with a space.
- A single word longer than the line is hard-split at the column limit.

### Row layout

1. Find the flex cell (first `width: "flex"`, else index 0).
2. Each non-flex cell's width = its `width` if numeric, else the width of its own
   text. `fixedTotal` = their sum. One space separates adjacent cells, so
   `gaps = cells.length - 1` and `flexW = cols - fixedTotal - gaps`.
3. **If `flexW >= 1`:** wrap the flex cell to `flexW`. Every line but the last
   prints alone; the **last** line is composed with the other cells padded to
   their widths, one space between cells. (This is what keeps a long item name
   ending on the same line as its amount.)
4. **If `flexW < 1`** (does not fit): the flex cell wraps across the full width on
   its own lines, then the remaining cells print right-aligned on the next line.
   This matches the old `pair()` behaviour exactly.
5. Non-flex cells are **truncated** to their width; the flex cell wraps.

### Padding style

Padding spaces inherit the style **shared by every non-empty segment on the
row** — a fully bold row stays bold through its gap, an underlined row draws the
underline through it — but padding never takes a *size*: a padding space is
always one column.

---

## 8. Stage 3 — emit ESC/POS

Emit a command **only when the state actually changes**, tracking align, bold,
size, underline, invert:

| What | Bytes |
|---|---|
| init (once, at the start) | `1B 40` (`ESC @`) |
| align left / center / right | `1B 61 00` / `1B 61 01` / `1B 61 02` |
| bold on / off | `1B 45 01` / `1B 45 00` |
| size | `1D 21 n` — `n` = `0x00` normal, `0x01` tall, `0x10` wide, `0x11` big |
| underline on / off | `1B 2D 01` / `1B 2D 00` |
| inverse (white on black) on / off | `1D 42 01` / `1D 42 00` |
| end of line | `0A` |
| cut | `1D 56 42 00` |

Per physical line: set alignment, then for each segment set its style and write
its bytes (ASCII only; drop anything else), then `0A`. Before a QR, an image or
the cut, reset to plain style. Encode the result as latin-1 / single-byte.

Full byte stream shape:

```
ESC @  ⟨lines⟩  ⟨feed⟩  GS V 66 0
```

---

## 9. Images

An image prints as a **1-bit raster between the text lines**, so a logo no longer
forces the whole receipt onto an image path.

1. Resolve `src` (`"logo"` ⇒ `store_logo_url` or `bill_logo_url`). Fetch with a
   short timeout; cache by URL (desktop caches 10 minutes). **If it cannot be
   fetched, skip the block silently** and print the rest.
2. Scale to `round(printheadDots × width% / 100 / 8) × 8` pixels wide, preserving
   aspect. Printhead dots: **384 on 58 mm, 576 on 80 mm**.
3. Threshold to 1 bit: `lum = 0.114·B + 0.587·G + 0.299·R + (255 − alpha)`; a
   pixel is black when `lum < 160`. The alpha term makes transparent pixels
   **white** — without it a transparent PNG logo prints as a solid black box.
4. Emit as `GS v 0` raster bands, at most 128 rows per band (small printer
   buffers):

```
1D 76 30 00  xL xH  yL yH  ⟨bitmap⟩      per band
   xL/xH = bytes per row = ceil(width / 8)
   yL/yH = rows in this band
   bitmap = row-major, MSB is the leftmost pixel, 1 = black
```

No `ESC @` and no cut inside a band sequence — those belong to the whole job.

---

## 10. QR codes

Emitted with the standard `GS ( k` model-2 sequence, error correction **L**:

```
1D 28 6B 03 00 31 43 n          module size n (1..16)
1D 28 6B 03 00 31 45 30         error correction L
1D 28 6B pL pH 31 50 30 ⟨data⟩  store data   (len = data.length + 3, pL = len % 256, pH = len / 256)
1D 28 6B 03 00 31 51 30         print
```

**Size.** Two forms, both must be supported:

- **Number 10–100** = the symbol's width as a percentage of the paper. Work out
  the module count from the data length (byte mode, EC level L), then
  `module = clamp(floor(paperDots × pct / 100 / modules), 1, 16)`.
  Module counts by version: `21 + 4·v` where `v` is the first version whose
  capacity holds the data. Byte capacities at EC L:
  `17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858`.
- **Legacy `"s"`, `"m"`, `"l"`** = fixed module sizes, kept so old layouts print
  unchanged: 80 mm ⇒ `3, 4, 6`; 58 mm ⇒ `3, 3, 4`.

Because the module size is a whole number of dots, neighbouring percentages can
land on the same printed size. That is expected.

---

## 11. The built-in layouts

`DEFAULT_TEMPLATE` (bill) and `DEFAULT_KOT_TEMPLATE` (kitchen ticket) in
`billTemplate.js` are the current hard-coded receipts expressed as blocks. **Copy
them verbatim into the Android port** — do not re-derive them. They are the
"Reset to default" target and the starting point of every first edit.

The bill, in order: logo (50%) · store name (bold, centred) · address · `Tel:` ·
rule · *Table* section · `Order: #{order_id}` · `Date`/`Time` row · `Type` ·
`Pay` · *Customer details* section · *Delivery boy* section · *Order notes*
section · rule · `ITEMS` (bold) · items (inline, amount right) · *Extra charges*
section · rule · Subtotal / Discount / Tax / **TOTAL** rows · rule ·
`Thank you for your visit!` · `Generated at:` · tax number · FSSAI · location QR ·
UPI QR · online-bill QR · blank · `Powered By Menuthere`.

The KOT: `KITCHEN ORDER TICKET` (bold, centred) · rule · *Table* section ·
`Order:` · `Type` · `Time` · *Order notes* section · rule · `ITEMS:` (bold) ·
items (bold, no amount, notes shown, blank line after each) · rule ·
`Generated at:` · blank · `Powered By Menuthere`.

---

## 12. Editor UI (if you build one)

Printing is the essential half. If the Android app should also *edit* layouts,
the desktop editor (`designer.html`) works like this and is worth mirroring:

- **Three panes:** block list, live paper preview, inspector for the selected
  block. On a phone, make these three tabs.
- **The preview is the real renderer** at the real column count — same resolve +
  fit code, rendered as monospace text instead of bytes. Never write a second
  "preview-only" layout engine; that is how the two drift apart.
- **The preview shows exactly what prints.** No faint placeholders for blocks
  that do not apply to the previewed order.
- **Preview per order kind** (Delivery / Takeaway / Dine-in / last printed
  order), with sample orders that exercise every block. Blocks that print for
  *another* kind but not the previewed one leave the list until you switch to
  that kind; blocks that print for *no* kind (a field this store never fills)
  stay listed but dimmed, so they can still be edited.
- **Word-level styling:** select text in the field, tap B / big / underline; the
  editor wraps the selection in tags.
- Drag to reorder, an eye icon to hide a block without deleting it, undo/redo,
  a 58/80 mm preview switch, **Test print** (sample order or last real order,
  always through the real byte path), and Save.
- An **"End of the bill"** entry at the bottom of the list edits
  `paper.feedLines` and `paper.cut`.
- The device opt-in is a switch labelled **"Use Customized bill / kot"**, above
  the Customize buttons, which are disabled while it is off.

---

## 13. Porting checklist & test plan

Order of work:

1. Data classes for the template; a tolerant parser (unknown keys ignored,
   anything invalid ⇒ `null` ⇒ built-in receipt).
2. Field resolution + inline markup → segments.
3. Resolve → logical lines (conditions, `hideIfEmpty`, items, groups, rule
   collapsing).
4. Fit → physical lines (wrap, row layout, padding).
5. Emit ESC/POS. **At this point the feature works**: read the layout from the
   payload, gate it behind the device opt-in, print.
6. Images and QR sizing.
7. Editor UI, then the sync API if the app should edit layouts.

**The one test that matters.** Render `DEFAULT_TEMPLATE` and compare against
what the app prints today, for the same orders, at **both 32 and 48 columns**.
They must be equivalent. The desktop repo has this as
`check-template-default.js`: it parses both byte streams into "what the printer
does" events (one per printed line, with its alignment and style runs, plus QR /
raster / cut events) and diffs those, so byte-level differences that print
identically are ignored:

- a redundant `ESC a` when the alignment did not change,
- trailing spaces on a line,
- the alignment of a blank line or of a line that fills every column.

Cover at least these orders: delivery with everything · dine-in with a table and
nothing optional · takeaway with a long wrapping address and two charges · UAE
(VAT label) · long item names · missing store name / phone / tax number ·
zero discount and zero tax · an order with no items.

Three differences from the old code are **intended** (the layout output is the
correct one):

| Case | Old | New |
|---|---|---|
| payload with no `id` | `Order: 77` | `Order: #77` |
| no `calculations` at all | prints a doubled rule | collapses it |
| very long order notes | the printer chops mid-word | wraps at spaces |

Finally, print on real hardware at both widths: a bold double-size line, an
underlined line, an inverted line, a logo, each QR size, and a receipt whose item
names wrap.

---

*Reference implementation: `billTemplate.js`, `main.js`
(`buildEscPosBill` / `buildEscPosKot`, `resolveImageLines`, sync),
`designer.html` (editor), `check-template-default.js` (equivalence test) — all in
the `cravings-software` repository. Desktop v1.6.4, 7 September 2026.*
