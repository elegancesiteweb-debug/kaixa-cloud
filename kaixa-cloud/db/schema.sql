-- ════════════════════════════════════════════════════════════
-- Kaixa Cloud — Esquema PostgreSQL para sincronización multi-sucursal
-- Modelo: negocio → sucursal → caja
-- ════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- para gen_random_uuid()

-- ── NEGOCIOS (cada cliente que te compra Kaixa Pro) ────────────
CREATE TABLE IF NOT EXISTS negocios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          TEXT NOT NULL,
  giro_principal  TEXT DEFAULT 'tienda',
  plan            TEXT DEFAULT 'multi_sucursal',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── SUCURSALES (ubicaciones físicas de un negocio) ─────────────
CREATE TABLE IF NOT EXISTS sucursales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  direccion       TEXT DEFAULT '',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── CAJAS (terminales individuales: madre o extra) ─────────────
CREATE TABLE IF NOT EXISTS cajas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id     UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  tipo            TEXT NOT NULL DEFAULT 'extra', -- 'madre' | 'extra'
  token           TEXT UNIQUE NOT NULL,           -- credencial de autenticación de esta caja
  ultimo_sync     TIMESTAMPTZ DEFAULT NULL,
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── CATEGORÍAS (compartidas por negocio) ────────────────────────
CREATE TABLE IF NOT EXISTS categorias (
  id              UUID PRIMARY KEY,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  emoji           TEXT DEFAULT '📦',
  giro            TEXT DEFAULT 'tienda',
  activo          BOOLEAN DEFAULT true,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

-- ── PRODUCTOS (inventario compartido del negocio) ───────────────
-- El "id" lo genera la caja donde se crea el producto (UUID),
-- así dos cajas offline nunca pueden crear el mismo id por accidente.
CREATE TABLE IF NOT EXISTS productos (
  id              UUID PRIMARY KEY,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_productos_negocio ON productos(negocio_id);

-- ── MOVIMIENTOS DE STOCK (ledger — el stock se calcula sumando) ─
-- Esto es lo que evita choques entre cajas: cada venta o ajuste
-- inserta un movimiento, nunca se sobrescribe un número fijo.
-- El "id" lo genera la caja de origen (UUID) — así nunca se duplica
-- aunque la misma caja reenvíe el mismo movimiento dos veces.
CREATE TABLE IF NOT EXISTS stock_movimientos (
  id              UUID PRIMARY KEY,        -- generado en la caja de origen
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  producto_id     UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  caja_id         UUID REFERENCES cajas(id),
  cantidad        INTEGER NOT NULL,        -- positivo = entrada, negativo = salida
  motivo          TEXT DEFAULT 'venta',    -- venta | ajuste | recepcion | devolucion
  venta_id        UUID DEFAULT NULL,
  creado_en       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movs_producto ON stock_movimientos(producto_id);

-- Vista de stock actual (suma de movimientos por producto)
CREATE OR REPLACE VIEW stock_actual AS
  SELECT producto_id, COALESCE(SUM(cantidad),0) AS stock
  FROM stock_movimientos
  GROUP BY producto_id;

-- ── CLIENTES (monedero compartido del negocio) ──────────────────
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

-- ── VENTAS ────────────────────────────────────────────────────
-- El "id" lo genera la caja que cobra (UUID) — esto es lo que permite
-- que la caja madre venda offline y mande sus folios sin chocar
-- con lo que vendieron otras cajas mientras tanto.
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
CREATE INDEX IF NOT EXISTS idx_ventas_negocio ON ventas(negocio_id);
CREATE INDEX IF NOT EXISTS idx_ventas_sucursal ON ventas(sucursal_id);

-- ── DETALLE DE VENTA ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venta_detalle (
  id                  UUID PRIMARY KEY,
  venta_id            UUID NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id         UUID REFERENCES productos(id),
  nombre_producto     TEXT DEFAULT '',
  cantidad            INTEGER DEFAULT 1,
  precio_unitario     NUMERIC(12,2) DEFAULT 0,
  subtotal            NUMERIC(12,2) DEFAULT 0
);

-- ── REGISTRO DE SINCRONIZACIÓN (auditoría / depuración) ─────────
CREATE TABLE IF NOT EXISTS sync_log (
  id              BIGSERIAL PRIMARY KEY,
  caja_id         UUID REFERENCES cajas(id),
  tabla           TEXT NOT NULL,
  accion          TEXT NOT NULL,
  origen_uuid     TEXT,
  procesado_en    TIMESTAMPTZ DEFAULT now()
);
