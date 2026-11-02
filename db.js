const sql = require("mssql");

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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
      console.warn(`DB connect attempt ${i} failed (${err.code || err.message}); retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function getPool() {
  if (!poolPromise) poolPromise = connectWithRetry().catch((e) => { poolPromise = null; throw e; });
  return poolPromise;
}

// Always pass user input as parameters (@name), never by joining strings into the SQL.
async function query(text, params = {}) {
  const request = (await getPool()).request();
  for (const [name, value] of Object.entries(params)) request.input(name, value);
  return (await request.query(text)).recordset || [];
}

module.exports = { query, getPool, sql };
