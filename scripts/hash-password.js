// Prints a bcrypt hash for a password. Needs NO database connection.
// Usage:  npm run hash-password
const bcrypt = require("bcryptjs");
const readline = require("readline");

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin });
      rl.once("line", (line) => { rl.close(); resolve(line); });
      return;
    }
    let input = "";
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === "\r" || c === "\n") { cleanup(); process.stdout.write("\n"); return resolve(input); }
        if (c === "\u0003") { cleanup(); process.stdout.write("\n"); process.exit(130); }
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
  const password = await askHidden("Password (min 10 characters): ");
  if (password.length < 10) { console.error("Password too short."); process.exit(1); }
  if (password !== (await askHidden("Repeat password: "))) { console.error("Passwords do not match."); process.exit(1); }
  console.log("\nYour hash (copy the whole line):\n");
  console.log(await bcrypt.hash(password, 12));
})();
