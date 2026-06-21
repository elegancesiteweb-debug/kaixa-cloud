// db/migrate.js — Aplica el esquema schema.sql a la base de datos
// Se ejecuta una vez al desplegar (o cuando cambie el esquema)
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('🔧 Aplicando esquema a la base de datos...');
  try {
    await pool.query(sql);
    console.log('✅ Esquema aplicado correctamente');
  } catch (e) {
    console.error('❌ Error aplicando esquema:', e.message);
    process.exit(1);
  }
  await pool.end();
}

migrate();
