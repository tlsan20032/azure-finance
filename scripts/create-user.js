// Usage:  node scripts/create-user.js <username> "<Display Name>" <admin|staff>
require("dotenv").config();
const bcrypt = require("bcryptjs");
const readline = require("readline");
const { query, getPool } = require("../db");

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    process.stdout.write(question);
    muted = true;
    rl.question("", (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

(async () => {
  const [username, displayName, role = "staff"] = process.argv.slice(2);
  if (!username || !displayName || !["admin", "staff"].includes(role)) {
    console.error('Usage: node scripts/create-user.js <username> "<Display Name>" <admin|staff>');
    process.exit(1);
  }
  const password = await askHidden("Password (min 10 characters): ");
  if (password.length < 10) { console.error("Password too short."); process.exit(1); }
  if (password !== (await askHidden("Repeat password: "))) { console.error("Passwords do not match."); process.exit(1); }

  try {
    const hash = await bcrypt.hash(password, 12);
    await query(
      "INSERT INTO dbo.users (username, display_name, password_hash, role) VALUES (@u, @d, @h, @r)",
      { u: username, d: displayName, h: hash, r: role });
    console.log(`Created ${role} "${username}".`);
  } catch (err) {
    console.error(err.number === 2627 ? "That username already exists." : `Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    (await getPool().catch(() => null))?.close();
  }
})();
