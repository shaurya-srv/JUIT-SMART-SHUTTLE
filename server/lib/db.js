// MySQL connection pool — uses mysql2 with promise wrapper.
// Reads connection details from environment variables.

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:             process.env.SHUTTLE_DB_HOST || '127.0.0.1',
  user:             process.env.SHUTTLE_DB_USER || 'root',
  password:         process.env.SHUTTLE_DB_PASS,
  database:         process.env.SHUTTLE_DB_NAME || 'shuttle_db',
  port:             parseInt(process.env.SHUTTLE_DB_PORT || '3306'),
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

module.exports = pool;
