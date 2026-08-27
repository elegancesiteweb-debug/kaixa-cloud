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

// Sin estos timeouts, una conexión que se cuelga (corte de red hacia la BD,
// query atorada) se queda ocupando un lugar del pool para siempre — nunca se
// libera ni da error, solo desaparece en silencio. Con el tiempo el pool
// entero termina lleno de conexiones muertas y CADA petición nueva (aunque
// la base de datos ya esté sana otra vez) se queda esperando un lugar libre
// que nunca llega. Esto fue justo lo que dejó el servidor colgado tras un
// corte: la BD volvió a estar disponible pero el pool ya estaba envenenado.
const pool = new Pool({
  connectionString: url,
  ssl: url && !esLocal ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  statement_timeout: 20000,
  query_timeout: 20000
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool de PostgreSQL:', err.message);
});

module.exports = pool;
