// Builds the invoice PDF on the server (no browser needed).
const PDFDocument = require("pdfkit");

const money = (n, cur) => {
  const v = new Intl.NumberFormat("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
  return cur === "SGD" ? "$" + v : `${cur} ${v}`;
};
const dmy = (d) => (d ? new Date(d).toISOString().slice(0, 10).split("-").reverse().join("/") : "");

function buildInvoicePdf({ invoice: v, items, settings: s = {} }) {
  return new Promise((resolve, reject) => {
    const tax = v.doc_type === "tax_invoice";
    const title = tax ? "TAX INVOICE" : "INVOICE";
    const cur = v.currency;
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `${title} ${v.invoice_no}`, Author: s.business_name || "" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const L = 50, R = 545, BOTTOM = doc.page.height - 80;
    const ensure = (y, h) => { if (y + h > BOTTOM) { doc.addPage(); return 50; } return y; };

    if (v.status === "void") { // faint diagonal stamp behind the content
      doc.save(); doc.rotate(-30, { origin: [300, 420] }).fillColor("#cc0000").fillOpacity(0.13)
        .font("Helvetica-Bold").fontSize(120).text("VOID", 110, 360, { width: 400, align: "center", lineBreak: false });
      doc.restore(); doc.fillOpacity(1);
    }

    // Header: business on the left, document details on the right
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(13).text(s.business_name || "", L, 50, { width: 260 });
    doc.font("Helvetica").fontSize(9).fillColor("#444");
    if (s.business_address) doc.text(s.business_address, L, doc.y, { width: 260 });
    if (s.gst_reg_no) doc.text(`GST Reg No: ${s.gst_reg_no}`, L, doc.y, { width: 260 });
    if (s.uen) doc.text(`UEN: ${s.uen}`, L, doc.y, { width: 260 });
    const leftEnd = doc.y;

    doc.fillColor("#000").font("Helvetica-Bold").fontSize(20).text(title, 300, 50, { width: 245, align: "right" });
    doc.font("Helvetica").fontSize(10);
    doc.text(`No. ${v.invoice_no}`, 300, doc.y + 2, { width: 245, align: "right" });
    doc.text(`Date: ${dmy(v.issue_date)}`, 300, doc.y, { width: 245, align: "right" });
    doc.text(`Due: ${dmy(v.due_date)}`, 300, doc.y, { width: 245, align: "right" });
    if (v.reference_no) doc.text(`Ref: ${v.reference_no}`, 300, doc.y, { width: 245, align: "right" });
    let y = Math.max(leftEnd, doc.y) + 22;

    // Bill to
    doc.fillColor("#666").font("Helvetica").fontSize(8).text("BILL TO", L, y);
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(11).text(v.client_name || "", L, doc.y + 2, { width: 300 });
    doc.font("Helvetica").fontSize(9).fillColor("#333");
    if (v.client_address) doc.text(v.client_address, L, doc.y, { width: 300 });
    if (v.client_gst_reg_no) doc.text(`GST Reg No: ${v.client_gst_reg_no}`, L, doc.y, { width: 300 });
    if (v.client_email) doc.text(v.client_email, L, doc.y, { width: 300 });
    y = doc.y + 18;

    // Items table
    const COL = { desc: [L, 215, "left"], qty: [270, 35, "right"], price: [310, 70, "right"], disc: [385, 50, "right"], gst: [440, 40, "right"], amt: [485, 60, "right"] };
    const header = (top) => {
      doc.rect(L, top, R - L, 18).fill("#eef2f5");
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(8.5);
      const head = { desc: "Description", qty: "Qty", price: `Unit price`, disc: "Discount", gst: "GST %", amt: "Amount (excl. GST)" };
      for (const k of Object.keys(COL)) doc.text(head[k], COL[k][0] + (k === "desc" ? 4 : 0), top + 5, { width: COL[k][1] - (k === "desc" ? 4 : 0), align: COL[k][2], lineBreak: false });
      return top + 24;
    };
    y = header(y);
    doc.font("Helvetica").fontSize(9).fillColor("#000");
    for (const x of items) {
      const desc = x.name + (x.unit ? ` (${x.unit})` : "");
      const h = Math.max(doc.heightOfString(desc, { width: COL.desc[1] - 4 }), 12) + 8;
      if (y + h > BOTTOM) { doc.addPage(); y = header(50); doc.font("Helvetica").fontSize(9).fillColor("#000"); }
      const disc = Number(x.discount_value) ? (x.discount_type === "percent" ? `${Number(x.discount_value)}%` : money(x.discount_value, cur)) : "";
      const cells = { desc, qty: String(Number(x.quantity)), price: money(x.unit_price, cur), disc, gst: String(Number(x.gst_rate)), amt: money(x.line_net, cur) };
      for (const k of Object.keys(COL)) doc.text(cells[k], COL[k][0] + (k === "desc" ? 4 : 0), y, { width: COL[k][1] - (k === "desc" ? 4 : 0), align: COL[k][2] });
      doc.moveTo(L, y + h - 3).lineTo(R, y + h - 3).lineWidth(0.4).strokeColor("#d8d8d8").stroke();
      y += h;
    }

    // Totals
    y = ensure(y + 10, 90);
    const line = (label, value, bold, gray) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5).fillColor(gray ? "#666" : "#000");
      doc.text(label, 320, y, { width: 130, lineBreak: false }); doc.text(value, 450, y, { width: 95, align: "right", lineBreak: false });
      y += bold ? 20 : 16;
    };
    line("Subtotal (excl. GST)", money(v.subtotal_ex_gst, cur));
    line("GST", money(v.gst_total, cur));
    doc.moveTo(320, y - 2).lineTo(R, y - 2).lineWidth(0.8).strokeColor("#000").stroke(); y += 3;
    line("Total", money(v.total, cur), true);
    if (cur !== "SGD" && v.sgd_exchange_rate) {
      doc.font("Helvetica").fontSize(8.5).fillColor("#666")
        .text(`GST in SGD: ${money(Number(v.gst_total) * Number(v.sgd_exchange_rate), "SGD")} (rate ${Number(v.sgd_exchange_rate)})`, 320, y, { width: 225, align: "right" });
      y = doc.y + 6;
    }

    // Notes, payment details, footer
    const block = (label, text, gray) => {
      if (!text) return;
      doc.font("Helvetica").fontSize(9);
      const h = doc.heightOfString(text, { width: R - L }) + 22;
      y = ensure(y + 10, h);
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(9).text(label, L, y);
      doc.font("Helvetica").fillColor(gray ? "#666" : "#222").text(text, L, doc.y + 1, { width: R - L });
      y = doc.y;
    };
    block("Notes", v.notes);
    block("Payment details", s.payment_details);
    block("", s.invoice_footer, true);

    doc.end();
  });
}
module.exports = { buildInvoicePdf };
