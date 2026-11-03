// Usage:  node scripts/create-user.js <username> "<Display Name>" <admin|staff>
require("dotenv").config();
const bcrypt = require("bcryptjs");
const readline = require("readline");
const { query, getPool } = require("../db");

// Reads a password without echoing it. Works in Windows Command Prompt / PowerShell.
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) { // input piped in (not typed): read a plain line
      const rl = readline.createInterface({ input: stdin });
      rl.once("line", (line) => { rl.close(); resolve(line); });
      return;
    }
    let input = "";
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === "\r" || c === "\n") { cleanup(); process.stdout.write("\n"); return resolve(input); }
        if (c === "\u0003") { cleanup(); process.stdout.write("\n"); process.exit(130); } // Ctrl+C
        if (c === "\u007f" || c === "\b") input = input.slice(0, -1);
        else input += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
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

  console.log("Connecting to the database (can take up to a minute if it was paused)...");
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
