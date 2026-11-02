const express = require("express");
const { query } = require("../db");
const { audit } = require("../audit");
const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const CURRENCIES = ["SGD", "USD", "EUR", "GBP", "MYR", "AUD", "JPY", "CNY", "HKD", "INR", "IDR", "THB"];

router.get("/", wrap(async (req, res) => {
  const [s] = await query(`SELECT business_name, business_address, gst_reg_no, uen, default_gst_rate,
    default_currency, payment_terms_days, payment_details, invoice_footer FROM dbo.app_settings WHERE id = 1`);
  res.json(s || {});
}));

router.put("/", wrap(async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can change business settings." });
  const b = req.body;
  const rate = Number(b.default_gst_rate), terms = parseInt(b.payment_terms_days, 10);
  const name = str(b.business_name, 200);
  if (!name) return res.status(400).json({ error: "Business name is required." });
  if (!(rate >= 0 && rate <= 100)) return res.status(400).json({ error: "GST % must be between 0 and 100." });
  if (!(terms >= 0 && terms <= 365)) return res.status(400).json({ error: "Payment terms must be 0 to 365 days." });
  const cur = CURRENCIES.includes(b.default_currency) ? b.default_currency : "SGD";
  await query(`UPDATE dbo.app_settings SET business_name=@name, business_address=@addr, gst_reg_no=@gst, uen=@uen,
      default_gst_rate=@rate, default_currency=@cur, payment_terms_days=@terms, payment_details=@pay,
      invoice_footer=@foot, updated_at=SYSUTCDATETIME() WHERE id=1`,
    { name, addr: str(b.business_address, 500) || null, gst: str(b.gst_reg_no, 50) || null,
      uen: str(b.uen, 50) || null, rate, cur, terms, pay: str(b.payment_details, 4000) || null,
      foot: str(b.invoice_footer, 4000) || null });
  await audit(req.user.id, "settings.update");
  res.json({ ok: true });
}));

module.exports = router;
