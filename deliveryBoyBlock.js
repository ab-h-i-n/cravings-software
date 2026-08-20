// "Delivery Boy" block for the RASTER print path.
//
// The web /bill payload carries `delivery_boy` (name + phone) only when the
// partner enabled the Bill Printing toggle AND a rider is assigned — but the page
// itself does not render it anywhere. The ESC/POS text path prints it directly;
// raster prints are a screenshot of that page, so the block has to be injected
// into the DOM before the capture or it would simply be missing.
//
// Placed directly under the delivery location (falling back to the address, then
// to the end of the receipt), with a rule above and below.

function deliveryBoyScript(info) {
  return `(() => {
    const info = ${JSON.stringify(info || null)};
    const root = document.getElementById('printable-content');
    if (!root || !info || (!info.name && !info.phone)) return "skipped";
    // Never double-insert: capture can be retried on the same page.
    if (root.querySelector('[data-cravings-delivery-boy]')) return "already";
    // If the web build ever starts rendering this block itself, do not add a
    // second copy — the page wins and we stay out of the way.
    if ((root.textContent || '').indexOf('Delivery Boy') !== -1) return "already-on-page";

    // The deepest element that actually owns this label, so we anchor on the
    // row itself rather than some wrapper spanning half the receipt.
    const leafWith = (needle) => Array.from(root.querySelectorAll('div,span,p,td,th'))
      .filter((el) => el.children.length === 0 && (el.textContent || '').indexOf(needle) !== -1)
      .pop();

    const block = document.createElement('div');
    block.setAttribute('data-cravings-delivery-boy', '1');
    block.style.borderTop = '1px solid #000';
    block.style.borderBottom = '1px solid #000';
    block.style.margin = '6px 0';
    block.style.padding = '4px 0';
    block.style.textAlign = 'left';

    const heading = document.createElement('div');
    heading.style.fontWeight = 'bold';
    heading.textContent = 'Delivery Boy';
    block.appendChild(heading);

    if (info.name) {
      const el = document.createElement('div');
      el.textContent = 'Name: ' + info.name;
      block.appendChild(el);
    }
    if (info.phone) {
      const el = document.createElement('div');
      el.textContent = 'Ph  : ' + info.phone;
      block.appendChild(el);
    }

    const anchor = leafWith('Delivery Location') || leafWith('Address:');
    if (anchor && anchor.parentElement && anchor.parentElement.parentElement) {
      const row = anchor.parentElement;
      row.parentElement.insertBefore(block, row.nextSibling);
      return "after:" + (anchor.textContent || '').trim().slice(0, 24);
    }
    root.appendChild(block);
    return "appended";
  })()`;
}

module.exports = { deliveryBoyScript };
