const { query } = require("./db");

// Records who did what. A failure here never breaks the user's action.
async function audit(userId, action, detail) {
  try {
    await query("INSERT INTO dbo.audit_log (user_id, action, detail) VALUES (@u, @a, @d)",
      { u: userId, a: action, d: detail || null });
  } catch (e) { console.error("audit failed:", e.message); }
}
module.exports = { audit };
