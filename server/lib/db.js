// PostgreSQL connection pool — uses pg (node-postgres).
// Reads connection details from environment variables.

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.SHUTTLE_DB_HOST || '127.0.0.1',
  user:     process.env.SHUTTLE_DB_USER || 'postgres',
  password: process.env.SHUTTLE_DB_PASS,
  database: process.env.SHUTTLE_DB_NAME || 'shuttle_db',
  port:     parseInt(process.env.SHUTTLE_DB_PORT || '5432'),
  max:      10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// pg uses $1, $2... placeholders and returns { rows, rowCount } instead of [rows, meta].
// Wrap queries to return an array-like format [rows] so existing code works.
const db = {
  async query(text, params) {
    const result = await pool.query(text, params);
    return [result.rows, result.rowCount];
  },
  async getConnection() {
    const client = await pool.connect();
    // Wrap client.query similarly
    const wrapped = {
      query: async (text, params) => {
        const r = await client.query(text, params);
        return [r.rows, r.rowCount];
      },
      beginTransaction: async () => { await client.query('BEGIN'); },
      commit:           async () => { await client.query('COMMIT'); },
      rollback:         async () => { await client.query('ROLLBACK'); },
      release:          () => { client.release(); },
    };
    return wrapped;
  },
  async end() {
    await pool.end();
  },
};

module.exports = db;
