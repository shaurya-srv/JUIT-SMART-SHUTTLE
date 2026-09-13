// Quick connectivity check: loads SHUTTLE_DB_* from env and tries a real query.
const { Client } = require('pg');

const required = ['SHUTTLE_DB_HOST', 'SHUTTLE_DB_PORT', 'SHUTTLE_DB_NAME', 'SHUTTLE_DB_USER', 'SHUTTLE_DB_PASS'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('✗ missing env vars:', missing.join(', '));
  process.exit(1);
}

const isRemote = !/^(localhost|127\.0\.0\.1)$/.test(process.env.SHUTTLE_DB_HOST);
const client = new Client({
  host: process.env.SHUTTLE_DB_HOST,
  port: Number(process.env.SHUTTLE_DB_PORT),
  database: process.env.SHUTTLE_DB_NAME,
  user: process.env.SHUTTLE_DB_USER,
  password: process.env.SHUTTLE_DB_PASS,
  ssl: isRemote ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
});

(async () => {
  try {
    await client.connect();
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log('✔ connected to', process.env.SHUTTLE_DB_HOST + ':' + process.env.SHUTTLE_DB_PORT);
    console.log('  tables:', rows.map((r) => r.table_name).join(', ') || '(none)');
    process.exit(0);
  } catch (err) {
    console.error('✗ connection failed:', err.message);
    process.exit(1);
  } finally {
    client.end().catch(() => {});
  }
})();
