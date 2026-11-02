require("dotenv").config();
const path = require("path");
const bcrypt = require("bcryptjs");
const cookieSession = require("cookie-session");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { query } = require("./db");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 20) {
  console.error("SESSION_SECRET is missing or too short (use 20+ random characters).");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(
  cookieSession({
    name: "sid",
    keys: [process.env.SESSION_SECRET],
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    httpOnly: true,
    sameSite: "strict",
    secure: PROD,
  })
);

// Azure App Service forwards "1.2.3.4:port"; strip the port so limits count per visitor.
function clientIp(req) {
  const ip = req.ip || "";
  const v4 = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4 ? v4[1] : ip;
}

async function audit(userId, action, detail) {
  try {
    await query("INSERT INTO dbo.audit_log (user_id, action, detail) VALUES (@u, @a, @d)",
      { u: userId, a: action, d: detail || null });
  } catch (e) { console.error("audit failed:", e.message); }
}

// Re-check the user in the database on every request, so deactivating
// someone takes effect immediately.
async function loadUser(req, res, next) {
  try {
    if (!req.session || !req.session.uid) return next();
    const [u] = await query(
      "SELECT id, username, display_name, role FROM dbo.users WHERE id = @id AND is_active = 1",
      { id: req.session.uid });
    if (u) req.user = u; else req.session = null;
    next();
  } catch (err) { next(err); }
}
app.use(loadUser);

const requireApiAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "Please sign in." });
const requirePageAuth = (req, res, next) =>
  req.user ? next() : res.redirect("/login.html");
const requireAdmin = (req, res, next) =>
  req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "Admins only." });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, keyGenerator: clientIp,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please wait a few minutes." },
});

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12); // keeps timing similar for unknown users

app.post("/api/login", loginLimiter, async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password || password.length > 200) {
      return res.status(400).json({ error: "Enter your username and password." });
    }
    const [user] = await query(
      `SELECT id, password_hash, is_active, failed_attempts, locked_until
         FROM dbo.users WHERE username = @u`, { u: username });

    const locked = user && user.locked_until && new Date(user.locked_until) > new Date();
    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !user.is_active || locked || !passwordOk) {
      if (user && !locked && !passwordOk) {
        await query(
          `UPDATE dbo.users
              SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE WHEN failed_attempts + 1 >= @max
                                      THEN DATEADD(MINUTE, @mins, SYSUTCDATETIME()) ELSE locked_until END
            WHERE id = @id`, { id: user.id, max: MAX_FAILED, mins: LOCK_MINUTES });
      }
      await audit(user ? user.id : null, "login.failed", `username=${username.slice(0, 100)}`);
      return res.status(401).json({ error: "Wrong username or password, or the account is locked." });
    }

    await query("UPDATE dbo.users SET failed_attempts = 0, locked_until = NULL, last_login_at = SYSUTCDATETIME() WHERE id = @id",
      { id: user.id });
    req.session = { uid: user.id };
    await audit(user.id, "login.ok");
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post("/api/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

app.get("/api/me", requireApiAuth, (req, res) =>
  res.json({ username: req.user.username, displayName: req.user.display_name, role: req.user.role }));

// Quick check that the database is reachable (also wakes a paused serverless database)
app.get("/api/health", requireApiAuth, requireAdmin, async (req, res, next) => {
  try { await query("SELECT 1 AS ok"); res.json({ database: "ok" }); } catch (e) { next(e); }
});

app.get("/", requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, "private", "index.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false })); // login page + css only

app.use((err, req, res, next) => {
  console.error(err);
  const dbDown = ["ESOCKET", "ETIMEOUT", "ELOGIN", "ECONNCLOSED", "ENOTFOUND", "ETIMEDOUT"].includes(err.code);
  res.status(dbDown ? 503 : 500).json({
    error: dbDown ? "The database is starting up or unreachable. Please try again in a minute."
                  : "Something went wrong.",
  });
});

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
