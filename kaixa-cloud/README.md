# Kaixa Cloud

Servidor central de sincronización multi-sucursal para Kaixa Pro.

## Qué hace

- Recibe las ventas/productos/clientes de la **Caja Madre** cuando se reconecta (offline-first)
- Atiende en vivo a las **Cajas Extra** (siempre conectadas, sin base de datos local)
- Avisa por WebSocket a todas las cajas de un mismo negocio cuando algo cambia
- Aísla los datos de cada negocio (multi-tenant) — nunca se mezclan entre clientes

## Desplegar en Railway (primera vez)

1. Crea cuenta en [railway.app](https://railway.app) (gratis para empezar)
2. **New Project** → **Deploy from GitHub repo** → sube esta carpeta `kaixa-cloud` a un repositorio de GitHub y selecciónalo
   - Alternativa sin GitHub: **New Project** → **Empty Project**, luego usa `railway up` desde la terminal dentro de esta carpeta (necesitas instalar [Railway CLI](https://docs.railway.app/guides/cli))
3. Dentro del proyecto, click **+ New** → **Database** → **PostgreSQL** — esto crea la base de datos y conecta automáticamente la variable `DATABASE_URL` a tu servicio
4. En el servicio de Node (no el de Postgres), ve a **Settings** → confirma que el **Start Command** sea `npm start`
5. Una vez desplegado, corre la migración para crear las tablas:
   - Desde Railway: abre la terminal del servicio (**View Logs** → ícono de terminal) y ejecuta `npm run migrate`
   - O localmente: copia el `DATABASE_URL` de Railway a tu `.env`, corre `npm install && npm run migrate`
6. Railway te da una URL pública (algo como `https://kaixa-cloud-production.up.railway.app`) — esa es la URL que vas a poner en cada Caja Madre y Caja Extra

## Dar de alta un negocio nuevo (cuando vendes Kaixa Pro multi-sucursal)

```bash
# 1. Crear el negocio
curl -X POST https://tu-url.railway.app/api/admin/negocios \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Joyería López","giro_principal":"joyeria"}'
# → te devuelve el negocio con su "id" (negocio_id)

# 2. Crear su(s) sucursal(es)
curl -X POST https://tu-url.railway.app/api/admin/sucursales \
  -H "Content-Type: application/json" \
  -d '{"negocio_id":"<id-del-paso-1>","nombre":"Sucursal Centro"}'
# → te devuelve la sucursal con su "id" (sucursal_id)

# 3. Crear la Caja Madre (la app .exe que ya conoces)
curl -X POST https://tu-url.railway.app/api/admin/cajas \
  -H "Content-Type: application/json" \
  -d '{"negocio_id":"<id>","sucursal_id":"<id>","nombre":"Caja Principal","tipo":"madre"}'
# → te devuelve un "token" — ese token se configura en la app .exe

# 4. Crear cajas extra (las que solo funcionan con internet)
curl -X POST https://tu-url.railway.app/api/admin/cajas \
  -H "Content-Type: application/json" \
  -d '{"negocio_id":"<id>","sucursal_id":"<id>","nombre":"Caja 2","tipo":"extra"}'
# → otro token, para esa caja extra
```

Cada caja se identifica con su `token` (header `x-caja-token` en cada request). Nunca se mezclan los datos entre negocios porque cada token solo da acceso a su propio `negocio_id`.

## Variables de entorno

Ver `.env.example`. En Railway, `DATABASE_URL` se inyecta sola al conectar el plugin de Postgres — no necesitas configurarla a mano.

## Endpoints principales

| Ruta | Quién la usa | Qué hace |
|---|---|---|
| `POST /api/admin/negocios` | Tú (vendedor) | Da de alta un negocio nuevo |
| `POST /api/admin/sucursales` | Tú (vendedor) | Da de alta una sucursal |
| `POST /api/admin/cajas` | Tú (vendedor) | Da de alta una caja, devuelve su token |
| `POST /api/sync/push` | Caja Madre | Sube lo que vendió offline |
| `GET /api/sync/pull` | Caja Madre | Descarga lo que pasó en otras cajas |
| `GET/POST /api/productos` | Caja Extra | Inventario en vivo |
| `GET/POST /api/clientes` | Caja Extra | Monedero en vivo |
| `POST /api/ventas` | Caja Extra | Cobrar en vivo |
