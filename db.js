const sql = require("mssql");

// Two ways to sign in to Azure SQL:
//  1) DB_USER + DB_PASSWORD set  -> SQL login (handy on your own computer)
//  2) neither set                -> passwordless Microsoft Entra sign-in. On Azure this uses the
//     App Service's managed identity; on your computer it uses your `az login` session.
const useSqlLogin = Boolean(process.env.DB_USER);

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  ...(useSqlLogin
    ? { user: process.env.DB_USER, password: process.env.DB_PASSWORD }
    : { authentication: { type: "azure-active-directory-default" } }),
  options: { encrypt: true, trustServerCertificate: false },
  connectionTimeout: 60000, // a paused serverless database can take a while to wake up
  requestTimeout: 30000,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

const ATTEMPTS = parseInt(process.env.DB_CONNECT_ATTEMPTS || "5", 10);
let poolPromise = null;

async function connectWithRetry() {
  for (let i = 1; ; i++) {
    try {
      const pool = await new sql.ConnectionPool(config).connect();
      pool.on("error", (err) => { console.error("DB pool error:", err.message); poolPromise = null; });
      return pool;
    } catch (err) {
      if (i >= ATTEMPTS) throw err;
      console.warn(`DB connect attempt ${i} failed: ${err.code || ""} ${err.message}; retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function getPool() {
  if (!poolPromise) poolPromise = connectWithRetry().catch((e) => { poolPromise = null; throw e; });
  return poolPromise;
}

function bind(request, params) {
  for (const [name, p] of Object.entries(params)) {
    if (p && typeof p === "object" && "type" in p && "value" in p) request.input(name, p.type, p.value);
    else request.input(name, p);
  }
  return request;
}

// Always pass user input as parameters (@name), never by joining strings into the SQL.
async function query(text, params = {}) {
  const request = bind((await getPool()).request(), params);
  return (await request.query(text)).recordset || [];
}

// Runs several statements as one unit: all succeed together or none are saved.
async function transaction(work) {
  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  const q = async (text, params = {}) =>
    (await bind(new sql.Request(tx), params).query(text)).recordset || [];
  try {
    const result = await work(q);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

module.exports = { query, transaction, getPool, sql };
