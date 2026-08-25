// db/pool.js — Conexión a PostgreSQL (DATABASE_URL la inyecta el proveedor
// que se esté usando — Railway, Neon, Render Postgres, etc.)
const { Pool } = require('pg');

// SSL para cualquier host remoto (todo proveedor de Postgres administrado lo
// exige — Neon, Railway, Render Postgres...). Antes esto solo activaba SSL
// si la URL contenía literalmente "railway", así que al cambiar de proveedor
// (o si la URL nunca trae ese texto) se intentaba conectar sin SSL y la
// conexión se caía/rechazaba. Solo se desactiva para una base local
// (localhost/127.0.0.1), típico de desarrollo.
const url = process.env.DATABASE_URL || '';
const esLocal = /localhost|127\.0\.0\.1/.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: url && !esLocal ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool de PostgreSQL:', err.message);
});

module.exports = pool;
