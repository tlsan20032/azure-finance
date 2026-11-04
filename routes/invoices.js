const express = require("express");
const { query, transaction, sql } = require("../db");
const { audit } = require("../audit");
const { calcInvoice } = require("../lib/calc");
const { sendMail } = require("../lib/mailer"); // Adjust paths based on your actual structure
const { buildInvoicePdf } = require("../lib/pdf");
const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const idOf = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const TYPES = ["tax_invoice", "invoice"];
const STATUSES = ["unpaid", "paid", "void"];
const CURRENCIES = ["SGD", "USD", "EUR", "GBP", "MYR", "AUD", "JPY", "CNY", "HKD", "INR", "IDR", "THB"];
const SORTS = { // fixed list, so user input never reaches the ORDER BY
  newest: "issue_date DESC, id DESC", oldest: "issue_date ASC, id ASC",
  number: "number_seq DESC", client: "client_name ASC", total: "total DESC",
};

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const d = new Date(s + "T00:00:00Z");
  return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : d;
}
const dateParam = (d) => ({ type: sql.Date, value: d });

function cleanItems(list) {
  if (!Array.isArray(list) || !list.length) return { error: "Add at least one product or service." };
  if (list.length > 100) return { error: "An invoice can have at most 100 lines." };
  const items = [];
  for (const [i, it] of list.entries()) {
    const n = i + 1;
    const x = {
      product_id: idOf(it.product_id), name: str(it.name, 300), unit: str(it.unit, 30) || null,
      unit_price: Number(it.unit_price), quantity: Number(it.quantity), gst_rate: Number(it.gst_rate),
      discount_type: it.discount_type === "amount" ? "amount" : "percent",
      discount_value: it.discount_value === "" || it.discount_value == null ? 0 : Number(it.discount_value),
    };
    if (!x.name) return { error: `Line ${n}: name is required.` };
    if (!(x.unit_price >= 0 && x.unit_price <= 1e9)) return { error: `Line ${n}: unit price is not valid.` };
    if (!(x.quantity > 0 && x.quantity <= 1e6)) return { error: `Line ${n}: quantity must be more than 0.` };
    if (!(x.gst_rate >= 0 && x.gst_rate <= 100)) return { error: `Line ${n}: GST % must be 0 to 100.` };
    if (!(x.discount_value >= 0)) return { error: `Line ${n}: discount is not valid.` };
    if (x.discount_type === "percent" && x.discount_value > 100) return { error: `Line ${n}: discount can't exceed 100%.` };
    items.push(x);
  }
  return { items };
}

function clean(b) {
  const issue = parseDate(b.issue_date), due = parseDate(b.due_date);
  if (!issue || !due) return { error: "Enter valid invoice and due dates." };
  if (due < issue) return { error: "The due date can't be before the invoice date." };
  if (!TYPES.includes(b.doc_type)) return { error: "Choose a document type." };
  const currency = String(b.currency || "SGD").toUpperCase();
  if (!CURRENCIES.includes(currency)) return { error: "Unsupported currency." };
  let rate = null;
  if (currency !== "SGD") {
    rate = Number(b.sgd_exchange_rate);
    if (!(rate > 0 && rate < 1e6)) return { error: "Enter the exchange rate to SGD (needed to show GST in SGD)." };
  }
  const client_name = str(b.client_name, 200);
  const client_email = str(b.client_email, 255) || null;
  if (!client_name) return { error: "The client's business name is required." };
  if (client_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client_email)) return { error: "The client's email doesn't look right." };
  const li = cleanItems(b.items);
  if (li.error) return li;
  const t = calcInvoice(li.items);
  if (t.total > 1e12) return { error: "The total is too large." };
  return { items: li.items, totals: t, head: {
    doc_type: b.doc_type, issue: dateParam(issue), due: dateParam(due), currency, rate,
    reference: str(b.reference_no, 100) || null, notes: str(b.notes, 4000) || null,
    email_text: str(b.email_text, 4000) || null, client_id: idOf(b.client_id),
    client_name, client_gst: str(b.client_gst_reg_no, 50) || null,
    client_address: str(b.client_address, 500) || null, client_email,
    sub: t.subtotal, gst: t.gst, total: t.total,
  } };
}

async function insertItems(q, invoiceId, items, totals) {
  for (const [i, x] of items.entries()) {
    await q(`INSERT INTO dbo.invoice_items (invoice_id, line_no, product_id, name, unit_price, gst_rate, quantity,
               unit, discount_type, discount_value, line_net, line_gst, line_total)
             VALUES (@inv, @line, @pid, @name, @price, @gst, @qty, @unit, @dtype, @dval, @net, @lgst, @ltotal)`, {
      inv: invoiceId, line: i + 1, pid: { type: sql.Int, value: x.product_id }, name: x.name,
      price: { type: sql.Decimal(18, 2), value: x.unit_price }, gst: { type: sql.Decimal(5, 2), value: x.gst_rate },
      qty: { type: sql.Decimal(18, 3), value: x.quantity }, unit: x.unit, dtype: x.discount_type,
      dval: { type: sql.Decimal(18, 2), value: x.discount_value },
      net: { type: sql.Decimal(18, 2), value: totals.lines[i].net },
      lgst: { type: sql.Decimal(18, 2), value: totals.lines[i].gst },
      ltotal: { type: sql.Decimal(18, 2), value: totals.lines[i].total },
    });
  }
}

const headParams = (h) => ({
  type: h.doc_type, issue: h.issue, due: h.due, cur: h.currency,
  rate: { type: sql.Decimal(18, 6), value: h.rate }, ref: h.reference, notes: h.notes, etext: h.email_text,
  cid: { type: sql.Int, value: h.client_id }, cname: h.client_name, cgst: h.client_gst,
  caddr: h.client_address, cemail: h.client_email,
  sub: { type: sql.Decimal(18, 2), value: h.sub }, gst: { type: sql.Decimal(18, 2), value: h.gst },
  total: { type: sql.Decimal(18, 2), value: h.total },
});

// ---------- list with filters and totals ----------
router.get("/", wrap(async (req, res) => {
  const where = ["1=1"], p = {};
  const from = parseDate(req.query.from), to = parseDate(req.query.to);
  if (from) { where.push("issue_date >= @from"); p.from = dateParam(from); }
  if (to) { where.push("issue_date <= @to"); p.to = dateParam(to); }
  const q = str(req.query.q, 100);
  if (q) {
    where.push("(invoice_no LIKE @like OR client_name LIKE @like OR reference_no LIKE @like)");
    p.like = "%" + q.replace(/[%_\[]/g, "[$&]") + "%";
  }
  if (STATUSES.includes(req.query.status)) { where.push("status = @status"); p.status = req.query.status; }
  if (TYPES.includes(req.query.type)) { where.push("doc_type = @dtype"); p.dtype = req.query.type; }
  const w = where.join(" AND ");
  const rows = await query(`SELECT TOP 500 id, invoice_no, doc_type, client_name, total, currency, status,
      issue_date, due_date, sent_at FROM dbo.invoices WHERE ${w} ORDER BY ${SORTS[req.query.sort] || SORTS.newest}`, p);
  const sums = await query(`SELECT status, SUM(total) AS total, SUM(gst_total) AS gst, SUM(subtotal_ex_gst) AS ex
      FROM dbo.invoices WHERE ${w} AND currency = 'SGD' AND status IN ('unpaid','paid') GROUP BY status`, p);
  const z = { total: 0, gst: 0, ex: 0 };
  const unpaid = sums.find((s) => s.status === "unpaid") || z, paid = sums.find((s) => s.status === "paid") || z;
  const add = (k) => Math.round((unpaid[k] + paid[k]) * 100) / 100;
  res.json({ rows, summary: { overall: { total: add("total"), gst: add("gst"), ex: add("ex") }, paid, unpaid } });
}));

router.get("/:id", wrap(async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad invoice id." });
  const [invoice] = await query("SELECT * FROM dbo.invoices WHERE id = @id", { id });
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });
  const items = await query("SELECT * FROM dbo.invoice_items WHERE invoice_id = @id ORDER BY line_no", { id });
  res.json({ invoice, items });
}));

// ---------- create (the number is taken inside the same transaction as the save) ----------
router.post("/", wrap(async (req, res) => {
  const r = clean(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    const out = await transaction(async (q) => {
      const [seq] = await q("UPDATE dbo.number_sequences SET next_value = next_value + 1 OUTPUT deleted.next_value AS n WHERE seq_key = 'invoice'");
      if (!seq) throw new Error("The invoice number counter is missing. Run the starting-data lines of schema.sql.");
      const [inv] = await q(`INSERT INTO dbo.invoices (doc_type, number_seq, invoice_no, issue_date, due_date, currency,
            sgd_exchange_rate, reference_no, notes, email_text, client_id, client_name, client_gst_reg_no,
            client_address, client_email, status, subtotal_ex_gst, gst_total, total, created_by)
          OUTPUT inserted.id
          VALUES (@type, @n, @no, @issue, @due, @cur, @rate, @ref, @notes, @etext, @cid, @cname, @cgst,
            @caddr, @cemail, 'unpaid', @sub, @gst, @total, @by)`,
        { ...headParams(r.head), n: seq.n, no: String(seq.n), by: req.user.id });
      await insertItems(q, inv.id, r.items, r.totals);
      return { id: inv.id, invoice_no: String(seq.n) };
    });
    await audit(req.user.id, "invoice.create", `id=${out.id} no=${out.invoice_no} total=${r.head.total}`);
    res.status(201).json(out);
  } catch (err) {
    if (err.number === 547) return res.status(400).json({ error: "That client no longer exists. Re-select it." });
    throw err;
  }
}));

// ---------- edit: only unpaid invoices that haven't been sent ----------
router.put("/:id", wrap(async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad invoice id." });
  const r = clean(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const [cur] = await query("SELECT status, sent_at FROM dbo.invoices WHERE id = @id", { id });
  if (!cur) return res.status(404).json({ error: "Invoice not found." });
  if (cur.status !== "unpaid" || cur.sent_at) {
    return res.status(409).json({ error: "Only unpaid invoices that haven't been sent can be edited. Copy it into a new invoice and void this one instead." });
  }
  await transaction(async (q) => {
    await q(`UPDATE dbo.invoices SET doc_type=@type, issue_date=@issue, due_date=@due, currency=@cur,
          sgd_exchange_rate=@rate, reference_no=@ref, notes=@notes, email_text=@etext, client_id=@cid,
          client_name=@cname, client_gst_reg_no=@cgst, client_address=@caddr, client_email=@cemail,
          subtotal_ex_gst=@sub, gst_total=@gst, total=@total, updated_at=SYSUTCDATETIME() WHERE id=@id`,
      { ...headParams(r.head), id });
    await q("DELETE FROM dbo.invoice_items WHERE invoice_id = @id", { id });
    await insertItems(q, id, r.items, r.totals);
  });
  await audit(req.user.id, "invoice.update", `id=${id} total=${r.head.total}`);
  res.json({ ok: true });
}));

router.post("/:id/status", wrap(async (req, res) => {
  const id = idOf(req.params.id), status = req.body.status;
  if (!id || !["paid", "unpaid"].includes(status)) return res.status(400).json({ error: "Bad request." });
  const rows = await query(`UPDATE dbo.invoices SET status=@status, paid_at = CASE WHEN @status='paid' THEN SYSUTCDATETIME() ELSE NULL END,
      updated_at=SYSUTCDATETIME() OUTPUT inserted.id WHERE id=@id AND status IN ('paid','unpaid')`, { id, status });
  if (!rows.length) return res.status(409).json({ error: "That invoice can't change status (it may be void)." });
  await audit(req.user.id, "invoice." + status, `id=${id}`);
  res.json({ ok: true });
}));

router.post("/:id/void", wrap(async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can void invoices." });
  const id = idOf(req.params.id), reason = str(req.body.reason, 500);
  if (!id) return res.status(400).json({ error: "Bad invoice id." });
  if (!reason) return res.status(400).json({ error: "Give a reason for voiding." });
  const rows = await query(`UPDATE dbo.invoices SET status='void', voided_at=SYSUTCDATETIME(), voided_by=@by,
      void_reason=@reason, updated_at=SYSUTCDATETIME() OUTPUT inserted.id WHERE id=@id AND status <> 'void'`,
    { id, by: req.user.id, reason });
  if (!rows.length) return res.status(409).json({ error: "Invoice not found or already void." });
  await audit(req.user.id, "invoice.void", `id=${id} reason=${reason}`);
  res.json({ ok: true });
}));

// ---------- send email with invoice pdf attachment ----------
router.post("/:id/send", wrap(async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad invoice id." });

  // 1. Fetch the complete invoice metadata
  const [invoice] = await query(
    "SELECT client_name, client_email, invoice_no, total, email_text, doc_type, status FROM dbo.invoices WHERE id = @id", 
    { id }
  );
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });
  if (!invoice.client_email) return res.status(400).json({ error: "This client does not have an email address." });

  // 2. Fetch the structural line items and global organization settings
  const items = await query("SELECT * FROM dbo.invoice_items WHERE invoice_id = @id ORDER BY line_no", { id });
  const [settings] = await query("SELECT business_name, business_address, gst_reg_no, uen, payment_details, invoice_footer FROM dbo.app_settings");

  // 3. Compile the PDF buffer automatically using your code template
  let pdfBuffer;
  try {
    pdfBuffer = await buildInvoicePdf({ invoice, items, settings: settings || {} });
  } catch (pdfErr) {
    console.error("PDF Compilation Failed:", pdfErr);
    return res.status(500).json({ error: "Could not compile the invoice document." });
  }

  // 4. Construct content layouts matching context
  const label = invoice.doc_type === "tax_invoice" ? "Tax Invoice" : "Invoice";
  const subject = `${label} #${invoice.invoice_no} from ${settings?.business_name || 'Our Company'}`;
  
  const emailMessage = invoice.email_text || 
    `Dear ${invoice.client_name || 'Customer'},\n\nPlease find your ${label.toLowerCase()} #${invoice.invoice_no} attached to this message.\n\nTotal Amount Due: $${invoice.total}\n\nThank you for your business.`;

  // 5. Send using your nodemailer script asset
  try {
    await sendMail({
      to: invoice.client_email,
      subject: subject,
      text: emailMessage,
      attachments: [
        {
          filename: `${label.replace(/\s+/g, '_')}_${invoice.invoice_no}.pdf`,
          content: pdfBuffer // Attaches binary PDF stream natively
        }
      ]
    });
  } catch (mailErr) {
    console.error("SMTP Transport Disconnected:", mailErr);
    return res.status(502).json({ error: "Email server delivery failed. Please verify SMTP environment variables configuration." });
  }

  // 6. Record timestamps into database
  await query(
    `UPDATE dbo.invoices 
     SET sent_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() 
     WHERE id = @id`, { id }
  );

  // 7. Push transaction entry to system audit trail logs
  await audit(req.user.id, "invoice.send", `id=${id} to=${invoice.client_email}`);
  
  res.json({ ok: true });
}));

module.exports = router;
