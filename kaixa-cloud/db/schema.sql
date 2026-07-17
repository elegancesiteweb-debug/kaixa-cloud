-- ════════════════════════════════════════════════════════════
-- Kaixa Cloud — Esquema PostgreSQL para sincronización multi-sucursal
-- Modelo: negocio → sucursal → caja
-- ════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── NEGOCIOS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS negocios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          TEXT NOT NULL,
  giro_principal  TEXT DEFAULT 'tienda',
  plan            TEXT DEFAULT 'multi_sucursal',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── SUCURSALES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sucursales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  direccion       TEXT DEFAULT '',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── CAJAS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cajas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  tipo            TEXT NOT NULL DEFAULT 'extra',
  token           TEXT UNIQUE NOT NULL,
  ultimo_sync     TIMESTAMPTZ DEFAULT NULL,
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── CATEGORÍAS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categorias (
  id              UUID PRIMARY KEY,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  emoji           TEXT DEFAULT '📦',
  giro            TEXT DEFAULT 'tienda',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── PRODUCTOS (inventario por SUCURSAL) ─────────────────────
-- sucursal_id hace que cada sucursal tenga su propio inventario
CREATE TABLE IF NOT EXISTS productos (
  id              UUID PRIMARY KEY,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  emoji           TEXT DEFAULT '📦',
  imagen_url      TEXT DEFAULT '',
  codigo_barras   TEXT DEFAULT '',
  precio          NUMERIC(12,2) DEFAULT 0,
  costo           NUMERIC(12,2) DEFAULT 0,
  stock_minimo    INTEGER DEFAULT 5,
  categoria_id    UUID REFERENCES categorias(id),
  giro            TEXT DEFAULT 'tienda',
  por_peso        BOOLEAN DEFAULT false,
  unidad_peso     TEXT DEFAULT 'kg',
  tiene_prescripcion BOOLEAN DEFAULT false,
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now(),
  actualizado_en  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_productos_negocio   ON productos(negocio_id);
CREATE INDEX IF NOT EXISTS idx_productos_sucursal  ON productos(sucursal_id);

-- ── MOVIMIENTOS DE STOCK (por sucursal) ────────────────────
CREATE TABLE IF NOT EXISTS stock_movimientos (
  id              UUID PRIMARY KEY,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID REFERENCES sucursales(id),
  producto_id     UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  caja_id         UUID REFERENCES cajas(id),
  cantidad        INTEGER NOT NULL,
  motivo          TEXT DEFAULT 'venta',
  venta_id        UUID DEFAULT NULL,
  creado_en       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movs_producto   ON stock_movimientos(producto_id);
CREATE INDEX IF NOT EXISTS idx_movs_sucursal   ON stock_movimientos(sucursal_id);

-- Vista de stock actual por producto Y sucursal
CREATE OR REPLACE VIEW stock_actual AS
  SELECT producto_id, sucursal_id, COALESCE(SUM(cantidad),0) AS stock
  FROM stock_movimientos
  GROUP BY producto_id, sucursal_id;

-- ── CLIENTES (compartidos por negocio) ──────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  id              UUID PRIMARY KEY,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  telefono        TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  rfc             TEXT DEFAULT '',
  giro            TEXT DEFAULT 'tienda',
  puntos          INTEGER DEFAULT 0,
  saldo           NUMERIC(12,2) DEFAULT 0,
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now(),
  actualizado_en  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_negocio ON clientes(negocio_id);

-- ── VENTAS (por sucursal) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ventas (
  id                  UUID PRIMARY KEY,
  negocio_id          UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id         UUID NOT NULL REFERENCES sucursales(id),
  caja_id             UUID REFERENCES cajas(id),
  folio               TEXT NOT NULL,
  cliente_id          UUID REFERENCES clientes(id),
  subtotal            NUMERIC(12,2) DEFAULT 0,
  descuento           NUMERIC(12,2) DEFAULT 0,
  iva                 NUMERIC(12,2) DEFAULT 0,
  total               NUMERIC(12,2) DEFAULT 0,
  forma_pago          TEXT DEFAULT 'efectivo',
  efectivo_recibido   NUMERIC(12,2) DEFAULT 0,
  cambio              NUMERIC(12,2) DEFAULT 0,
  cajero              TEXT DEFAULT '',
  giro                TEXT DEFAULT 'tienda',
  estado              TEXT DEFAULT 'completada',
  referencia_externa  TEXT DEFAULT NULL,
  creado_en           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ventas_negocio   ON ventas(negocio_id);
CREATE INDEX IF NOT EXISTS idx_ventas_sucursal  ON ventas(sucursal_id);

-- ── DETALLE DE VENTA ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venta_detalle (
  id                  UUID PRIMARY KEY,
  venta_id            UUID NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id         UUID REFERENCES productos(id),
  nombre_producto     TEXT DEFAULT '',
  cantidad            INTEGER DEFAULT 1,
  precio_unitario     NUMERIC(12,2) DEFAULT 0,
  subtotal            NUMERIC(12,2) DEFAULT 0
);

-- ── SYNC LOG ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_log (
  id              BIGSERIAL PRIMARY KEY,
  caja_id         UUID REFERENCES cajas(id),
  tabla           TEXT NOT NULL,
  accion          TEXT NOT NULL,
  origen_uuid     TEXT,
  procesado_en    TIMESTAMPTZ DEFAULT now()
);

-- ── EMPLEADOS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS empleados (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID REFERENCES sucursales(id),
  nombre          TEXT NOT NULL,
  rol             TEXT DEFAULT 'cajero',
  usuario         TEXT,
  password        TEXT,
  activo          BOOLEAN DEFAULT true,
  ultima_entrada  TIMESTAMPTZ,
  ultima_salida   TIMESTAMPTZ,
  creado_en       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_empleados_negocio   ON empleados(negocio_id);
CREATE INDEX IF NOT EXISTS idx_empleados_sucursal  ON empleados(sucursal_id);

-- ── LOTES Y CADUCIDADES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS lotes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID REFERENCES sucursales(id),
  producto_id     UUID REFERENCES productos(id),
  nombre_producto TEXT DEFAULT '',
  numero_lote     TEXT NOT NULL,
  cantidad        INTEGER DEFAULT 0,
  fecha_caducidad DATE,
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now(),
  actualizado_en  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lotes_sucursal ON lotes(sucursal_id);

-- ── PROVEEDORES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proveedores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  telefono        TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── PEDIDOS A PROVEEDORES ────────────────────────────────────
CREATE TABLE IF NOT EXISTS pedidos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID REFERENCES sucursales(id),
  proveedor_id    UUID REFERENCES proveedores(id),
  proveedor_nombre TEXT DEFAULT '',
  estado          TEXT DEFAULT 'pendiente',
  total           NUMERIC(12,2) DEFAULT 0,
  notas           TEXT DEFAULT '',
  creado_en       TIMESTAMPTZ DEFAULT now(),
  actualizado_en  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pedido_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id     UUID REFERENCES productos(id),
  nombre_producto TEXT DEFAULT '',
  cantidad        INTEGER DEFAULT 1,
  costo_unitario  NUMERIC(12,2) DEFAULT 0,
  subtotal        NUMERIC(12,2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pedidos_sucursal ON pedidos(sucursal_id);

-- ── CORTES DE CAJA ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cortes_caja (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID REFERENCES sucursales(id),
  caja_id         UUID REFERENCES cajas(id),
  tipo            TEXT DEFAULT 'parcial',
  total_ventas    INTEGER DEFAULT 0,
  total_monto     NUMERIC(12,2) DEFAULT 0,
  efectivo        NUMERIC(12,2) DEFAULT 0,
  tarjeta         NUMERIC(12,2) DEFAULT 0,
  transferencia   NUMERIC(12,2) DEFAULT 0,
  cajero_nombre   TEXT DEFAULT '',
  notas           TEXT DEFAULT '',
  creado_en       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cortes_sucursal ON cortes_caja(sucursal_id);

-- ── TRASPASOS ENTRE SUCURSALES ────────────────────────────────
-- Instantáneo: se descuenta de origen y se suma a destino en el mismo momento.
CREATE TABLE IF NOT EXISTS traspasos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id           UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_origen_id   UUID NOT NULL REFERENCES sucursales(id),
  sucursal_destino_id  UUID NOT NULL REFERENCES sucursales(id),
  tipo                 TEXT NOT NULL DEFAULT 'producto',
  producto_origen_id   UUID REFERENCES productos(id),
  producto_destino_id  UUID REFERENCES productos(id),
  lote_origen_id       UUID REFERENCES lotes(id),
  lote_destino_id      UUID REFERENCES lotes(id),
  nombre_item          TEXT DEFAULT '',
  cantidad             NUMERIC(10,3) NOT NULL,
  usuario_nombre       TEXT DEFAULT '',
  notas                TEXT DEFAULT '',
  creado_en            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_traspasos_origen  ON traspasos(sucursal_origen_id);
CREATE INDEX IF NOT EXISTS idx_traspasos_destino ON traspasos(sucursal_destino_id);

-- ── Vínculo producto → proveedor (para pedidos sugeridos por proveedor) ──
ALTER TABLE productos ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON productos(proveedor_id);
