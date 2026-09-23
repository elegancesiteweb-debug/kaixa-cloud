// routes/auditoria.js — Revisa la salud de los datos en producción (solo lectura)
const pool = require('../db/pool');

const REVISIONES = [
  {
    id: 'recepcion_inicial_duplicada',
    titulo: 'Productos con más de una recepción inicial de stock',
    severidad: 'critica',
    sql: `SELECT m.producto_id, p.nombre AS producto, n.nombre AS negocio, COUNT(*) AS recepciones
          FROM stock_movimientos m
          LEFT JOIN productos p ON p.id = m.producto_id
          LEFT JOIN negocios n ON n.id = m.negocio_id
          WHERE m.motivo = 'recepcion'
          GROUP BY m.producto_id, p.nombre, n.nombre HAVING COUNT(*) > 1`
  },
  {
    id: 'recepcion_mas_ajuste_mismo_monto',
    titulo: 'Recepción + ajuste del mismo monto (huella del bug de doble conteo)',
    severidad: 'critica',
    sql: `SELECT r.producto_id, p.nombre AS producto, n.nombre AS negocio, r.cantidad
          FROM stock_movimientos r
          JOIN stock_movimientos a ON a.producto_id = r.producto_id AND a.cantidad = r.cantidad AND a.motivo = 'ajuste'
          LEFT JOIN productos p ON p.id = r.producto_id
          LEFT JOIN negocios n ON n.id = r.negocio_id
          WHERE r.motivo = 'recepcion'
            AND ABS(EXTRACT(EPOCH FROM (a.creado_en - r.creado_en))) < 86400
            AND NOT EXISTS (SELECT 1 FROM stock_movimientos c
                            WHERE c.motivo = 'correccion_bug_duplicado' AND c.producto_id = r.producto_id)`
  },
  {
    id: 'stock_negativo',
    titulo: 'Productos activos con stock negativo',
    severidad: 'alta',
    sql: `SELECT p.id AS producto_id, p.nombre AS producto, n.nombre AS negocio, s.nombre AS sucursal, sa.stock
          FROM stock_actual sa
          JOIN productos p ON p.id = sa.producto_id AND p.activo = true AND COALESCE(p.es_servicio,false) = false
          LEFT JOIN negocios n ON n.id = p.negocio_id
          LEFT JOIN sucursales s ON s.id = sa.sucursal_id
          WHERE sa.stock < 0 ORDER BY sa.stock LIMIT 50`
  },
  {
    id: 'traspasos_atorados',
    titulo: 'Traspasos enviados sin recibir ni rechazar por más de 3 días',
    severidad: 'alta',
    sql: `SELECT t.id, n.nombre AS negocio, t.nombre_item, t.cantidad, t.creado_en
          FROM traspasos t LEFT JOIN negocios n ON n.id = t.negocio_id
          WHERE t.estado = 'enviado' AND t.creado_en < now() - interval '3 days'`
  },
  {
    id: 'traspasos_sin_movimiento_origen',
    titulo: 'Traspasos de producto sin su movimiento de salida en origen',
    severidad: 'critica',
    sql: `SELECT t.id, n.nombre AS negocio, t.nombre_item, t.cantidad, t.estado
          FROM traspasos t LEFT JOIN negocios n ON n.id = t.negocio_id
          WHERE t.tipo = 'producto' AND t.producto_origen_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM stock_movimientos m
                            WHERE m.producto_id = t.producto_origen_id AND m.motivo = 'traspaso_salida'
                              AND m.sucursal_id = t.sucursal_origen_id AND m.cantidad = -t.cantidad)`
  },
  {
    id: 'traspasos_rechazados_sin_devolucion',
    titulo: 'Traspasos rechazados cuyo stock no regresó a origen',
    severidad: 'critica',
    sql: `SELECT t.id, n.nombre AS negocio, t.nombre_item, t.cantidad
          FROM traspasos t LEFT JOIN negocios n ON n.id = t.negocio_id
          WHERE t.estado = 'rechazado' AND t.tipo = 'producto' AND t.producto_origen_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM stock_movimientos m
                            WHERE m.producto_id = t.producto_origen_id AND m.sucursal_id = t.sucursal_origen_id
                              AND m.cantidad = t.cantidad AND m.motivo IN ('traspaso_rechazado','traspaso_salida'))`
  },
  {
    id: 'cajas_sin_sincronizar',
    titulo: 'Cajas activas sin sincronizar en más de 24 horas',
    severidad: 'media',
    sql: `SELECT c.id, c.nombre AS caja, n.nombre AS negocio, c.ultimo_sync
          FROM cajas c LEFT JOIN negocios n ON n.id = c.negocio_id
          WHERE COALESCE(c.activo, true) = true
            AND (c.ultimo_sync IS NULL OR c.ultimo_sync < now() - interval '24 hours')`
  },
  {
    id: 'ventas_sin_detalle',
    titulo: 'Ventas completadas de los últimos 30 días sin renglones de detalle',
    severidad: 'media',
    sql: `SELECT v.id, v.folio, n.nombre AS negocio, v.total, v.creado_en
          FROM ventas v LEFT JOIN negocios n ON n.id = v.negocio_id
          WHERE v.estado = 'completada' AND v.creado_en > now() - interval '30 days'
            AND NOT EXISTS (SELECT 1 FROM venta_detalle d WHERE d.venta_id = v.id) LIMIT 50`
  },
  {
    id: 'movimientos_huerfanos',
    titulo: 'Movimientos de stock de productos que ya no existen',
    severidad: 'baja',
    sql: `SELECT m.producto_id, COUNT(*) AS movimientos
          FROM stock_movimientos m
          WHERE NOT EXISTS (SELECT 1 FROM productos p WHERE p.id = m.producto_id)
          GROUP BY m.producto_id LIMIT 50`
  },
  {
    id: 'productos_repetidos_por_nombre',
    titulo: 'Productos activos repetidos (mismo nombre en la misma sucursal)',
    severidad: 'baja',
    sql: `SELECT n.nombre AS negocio, lower(p.nombre) AS nombre, COUNT(*) AS veces
          FROM productos p LEFT JOIN negocios n ON n.id = p.negocio_id
          WHERE p.activo = true
          GROUP BY n.nombre, p.negocio_id, p.sucursal_id, lower(p.nombre) HAVING COUNT(*) > 1 LIMIT 50`
  }
];

async function correrAuditoria() {
  const resultados = [];
  for (const r of REVISIONES) {
    try {
      const q = await pool.query(r.sql);
      resultados.push({ id: r.id, titulo: r.titulo, severidad: r.severidad, ok: q.rows.length === 0, total: q.rows.length, muestra: q.rows.slice(0, 10) });
    } catch (e) {
      resultados.push({ id: r.id, titulo: r.titulo, severidad: r.severidad, ok: false, error: e.message, total: null, muestra: [] });
    }
  }
  return {
    ok: resultados.every(r => r.ok),
    revisadas: resultados.length,
    con_problemas: resultados.filter(r => !r.ok).length,
    generado_en: new Date().toISOString(),
    resultados
  };
}

module.exports = { correrAuditoria };
