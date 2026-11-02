// All money maths is done in whole cents to avoid floating-point drift.
const cents = (n) => Math.round(Number(n) * 100);

function calcLine(it) {
  const price = cents(it.unit_price);
  const gross = Math.round(price * Number(it.quantity));
  let disc = it.discount_type === "amount"
    ? cents(it.discount_value)
    : Math.round((gross * Number(it.discount_value)) / 100);
  disc = Math.min(Math.max(disc, 0), gross);
  const net = gross - disc;
  const gst = Math.round((net * Number(it.gst_rate)) / 100); // GST rounded per line
  return { net, gst, total: net + gst };
}

function calcInvoice(items) {
  const lines = items.map(calcLine);
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  return {
    lines: lines.map((l) => ({ net: l.net / 100, gst: l.gst / 100, total: l.total / 100 })),
    subtotal: sum("net") / 100, gst: sum("gst") / 100, total: sum("total") / 100,
  };
}
module.exports = { calcLine, calcInvoice };
