const express = require("express");
const { query, sql } = require("../db");
const { audit } = require("../audit");
const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const idOf = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const dec = (v, scale) => ({ type: sql.Decimal(18, scale), value: v });

// ---------- categories ----------
router.get("/categories", wrap(async (req, res) => {
  res.json(await query("SELECT id, name FROM dbo.product_categories ORDER BY position, name"));
}));

router.post("/categories", wrap(async (req, res) => {
  const name = str(req.body.name, 150);
  if (!name) return res.status(400).json({ error: "Category name is required." });
  try {
    const [row] = await query("INSERT INTO dbo.product_categories (name) OUTPUT inserted.id VALUES (@name)", { name });
    await audit(req.user.id, "category.create", `id=${row.id} name=${name}`);
    res.status(201).json({ id: row.id });
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ error: "That category already exists." });
    throw err;
  }
}));

router.delete("/categories/:id", wrap(async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can delete categories." });
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad category id." });
  await query("UPDATE dbo.products SET category_id = NULL WHERE category_id = @id", { id }); // products stay, uncategorised
  await query("DELETE FROM dbo.product_categories WHERE id = @id", { id });
  await audit(req.user.id, "category.delete", `id=${id}`);
  res.json({ ok: true });
}));

// ---------- products & services ----------
function clean(body) {
  const price = Number(body.unit_price);
  const gst = body.gst_rate === "" || body.gst_rate == null ? 9 : Number(body.gst_rate);
  const p = {
    name: str(body.name, 300),
    unit: str(body.unit, 30) || null,
    category_id: body.category_id ? idOf(body.category_id) : null,
  };
  if (!p.name) return { error: "Name is required." };
  if (!Number.isFinite(price) || price < 0 || price > 1e9) return { error: "Enter a valid unit price (before GST)." };
  if (!Number.isFinite(gst) || gst < 0 || gst > 100) return { error: "GST % must be between 0 and 100." };
  return { p, price: Math.round(price * 100) / 100, gst: Math.round(gst * 100) / 100 };
}

const params = ({ p, price, gst }) => ({
  name: p.name, unit: p.unit, category_id: { type: sql.Int, value: p.category_id },
  unit_price: dec(price, 2), gst_rate: { type: sql.Decimal(5, 2), value: gst },
});

router.get("/products", wrap(async (req, res) => {
  const q = str(req.query.q, 100);
  const like = "%" + q.replace(/[%_\[]/g, "[$&]") + "%";
  res.json(await query(
    `SELECT TOP 500 p.id, p.name, p.unit_price, p.gst_rate, p.unit, p.category_id, c.name AS category
       FROM dbo.products p LEFT JOIN dbo.product_categories c ON c.id = p.category_id
      WHERE p.is_active = 1 AND (@cat IS NULL OR p.category_id = @cat) AND (@q = N'' OR p.name LIKE @like)
      ORDER BY c.name, p.name`,
    { q, like, cat: { type: sql.Int, value: idOf(req.query.category) } }));
}));

router.post("/products", wrap(async (req, res) => {
  const r = clean(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const [row] = await query(
    `INSERT INTO dbo.products (category_id, name, unit_price, gst_rate, unit)
     OUTPUT inserted.id VALUES (@category_id, @name, @unit_price, @gst_rate, @unit)`, params(r));
  await audit(req.user.id, "product.create", `id=${row.id} name=${r.p.name}`);
  res.status(201).json({ id: row.id });
}));

router.put("/products/:id", wrap(async (req, res) => {
  const id = idOf(req.params.id);
  const r = clean(req.body);
  if (!id) return res.status(400).json({ error: "Bad product id." });
  if (r.error) return res.status(400).json({ error: r.error });
  const rows = await query(
    `UPDATE dbo.products SET category_id=@category_id, name=@name, unit_price=@unit_price,
            gst_rate=@gst_rate, unit=@unit OUTPUT inserted.id WHERE id=@id AND is_active=1`,
    { ...params(r), id });
  if (!rows.length) return res.status(404).json({ error: "Product not found." });
  await audit(req.user.id, "product.update", `id=${id}`);
  res.json({ ok: true });
}));

router.delete("/products/:id", wrap(async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can deactivate products." });
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad product id." });
  const rows = await query("UPDATE dbo.products SET is_active=0 OUTPUT inserted.id WHERE id=@id AND is_active=1", { id });
  if (!rows.length) return res.status(404).json({ error: "Product not found." });
  await audit(req.user.id, "product.deactivate", `id=${id}`);
  res.json({ ok: true });
}));

module.exports = router;
