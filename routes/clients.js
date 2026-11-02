const express = require("express");
const { query } = require("../db");
const { audit } = require("../audit");
const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const idOf = (req) => { const n = parseInt(req.params.id, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v, max) => String(v ?? "").trim().slice(0, max);

function clean(body) {
  const c = {
    business_name: str(body.business_name, 200),
    gst_reg_no: str(body.gst_reg_no, 50) || null,
    address: str(body.address, 500) || null,
    email: str(body.email, 255) || null,
  };
  if (!c.business_name) return { error: "Business name is required." };
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return { error: "That email address doesn't look right." };
  return { c };
}

router.get("/", wrap(async (req, res) => {
  const q = str(req.query.q, 100);
  const like = "%" + q.replace(/[%_\[]/g, "[$&]") + "%";
  res.json(await query(
    `SELECT TOP 500 id, business_name, gst_reg_no, address, email FROM dbo.clients
      WHERE is_active = 1 AND (@q = N'' OR business_name LIKE @like OR email LIKE @like)
      ORDER BY business_name`, { q, like }));
}));

router.post("/", wrap(async (req, res) => {
  const { c, error } = clean(req.body);
  if (error) return res.status(400).json({ error });
  const [row] = await query(
    `INSERT INTO dbo.clients (business_name, gst_reg_no, address, email)
     OUTPUT inserted.id VALUES (@business_name, @gst_reg_no, @address, @email)`, c);
  await audit(req.user.id, "client.create", `id=${row.id} name=${c.business_name}`);
  res.status(201).json({ id: row.id });
}));

router.put("/:id", wrap(async (req, res) => {
  const id = idOf(req);
  const { c, error } = clean(req.body);
  if (!id) return res.status(400).json({ error: "Bad client id." });
  if (error) return res.status(400).json({ error });
  const rows = await query(
    `UPDATE dbo.clients SET business_name=@business_name, gst_reg_no=@gst_reg_no, address=@address,
            email=@email, updated_at=SYSUTCDATETIME()
     OUTPUT inserted.id WHERE id=@id AND is_active=1`, { ...c, id });
  if (!rows.length) return res.status(404).json({ error: "Client not found." });
  await audit(req.user.id, "client.update", `id=${id}`);
  res.json({ ok: true });
}));

// "Delete" only hides the client, because issued invoices still refer to it. Admins only.
router.delete("/:id", wrap(async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can deactivate clients." });
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Bad client id." });
  const rows = await query("UPDATE dbo.clients SET is_active=0, updated_at=SYSUTCDATETIME() OUTPUT inserted.id WHERE id=@id AND is_active=1", { id });
  if (!rows.length) return res.status(404).json({ error: "Client not found." });
  await audit(req.user.id, "client.deactivate", `id=${id}`);
  res.json({ ok: true });
}));

module.exports = router;
