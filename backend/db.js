require('dotenv').config();

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:             process.env.DB_HOST || 'localhost',
  port:             parseInt(process.env.DB_PORT, 10) || 3306,
  user:             process.env.DB_USER || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_NAME || 'werkplaats',
  waitForConnections: true,
  connectionLimit:  10,
  timezone:         '+00:00',
  dateStrings:      true,
  ssl:              { rejectUnauthorized: false },
});

// ISO 8601 ('2024-07-08T17:25:33.123Z') → MySQL datetime ('2024-07-08 17:25:33')
function fixDatum(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 19).replace('T', ' ');
  }
  return v;
}

function fixParams(params) {
  if (!Array.isArray(params)) return params;
  return params.map(fixDatum);
}

// Wrapper zodat alle queries automatisch ISO-datums omzetten
const proxy = {
  query: (sql, params) => pool.query(sql, fixParams(params)),
  execute: (sql, params) => pool.execute(sql, fixParams(params)),
};

module.exports = proxy;