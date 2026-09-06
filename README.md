# DESENCAJADO — Web de suscripción + wallet de fidelidad

Sitio de **DESENCAJADO — Papas y Café** (Huaraz) con dos partes:

1. **Pre-registro** para la apertura (nombre, teléfono, DNI) — igual que antes.
2. **Wallet de fidelidad**: login con Google + **vinculación de DNI y
   celular** (paso obligatorio único, ya que Google no los entrega —
   sienta la base para futuras campañas segmentadas, ej. por cumpleaños),
   verificación en dos pasos (2FA)
   por código QR (con bloqueo tras varios intentos fallidos), estrellas por
   consumo canjeables más adelante (con barra de progreso hacia la próxima
   recompensa), código de referidos **con bono de puntos** para quien refiere
   y para el referido, cuentas familiares/compartidas (crear, unirse, salir,
   expulsar miembros), tarjeta real de **Google Wallet**, notificaciones
   **push** de promociones (con cuenta regresiva cuando la promo tiene fecha
   de vencimiento), **niveles de fidelidad** (Bronce/Plata/Oro según
   estrellas ganadas de por vida), una **ruleta de premios** diaria con
   cooldown, y cierre de sesión en todos los dispositivos.
3. **Panel de administrador**: tráfico de consumo por horario, usuarios y su
   wallet (con buscador y exportación a CSV, y botón para forzar el cierre
   de sesión de un cliente), afiliados, grupos compartidos, registro de
   compras desde un formulario, **catálogo de productos** (crear/editar/
   desactivar/eliminar), **promociones completas y programables** (foto,
   vigencia, productos asociados, código de publicación autogenerado,
   códigos de canje por sucursal/tanda con límite de usos, editar/
   desactivar/eliminar) con banner + popup + push — si se les pone una
   fecha de inicio futura quedan guardadas sin avisarle a nadie hasta que
   llegue el día (por día, no por hora todavía), y **campos de perfil
   dinámicos**: crear en
   cualquier momento un dato nuevo a pedirle al cliente (ej. fecha de
   nacimiento, un número de referencia) sin tocar código — si se marca
   obligatorio, se le pide la próxima vez que entra a su cuenta.

Todo corre en un servidor HTTP plano (sin frameworks), escrito en
**TypeScript** con `strict: true`, con persistencia en SQLite, tests
automatizados (`node:test`, sin dependencias), CI en GitHub Actions, y
listo para correr en Docker.

## Requisitos

- Node.js 22.5 o superior (usa el módulo experimental `node:sqlite`). Las
  primeras patch de la serie 22.5.x todavía piden el flag
  `--experimental-sqlite` para poder usarlo (falla con
  `ERR_UNKNOWN_BUILTIN_MODULE` sin él); versiones más nuevas de Node 22 no
  lo necesitan — usá la última patch disponible de Node 22 si podés.
- `typescript` como única **devDependency** (compila `src/` → `dist/`; no
  agrega nada a producción, `npm ci --omit=dev` no la instala).
- El TOTP y el JWT de Google Wallet se implementan con `node:crypto` puro
  (sin dependencias). El QR de 2FA se dibuja en el navegador con
  [qrcodejs](https://github.com/davidshimjs/qrcodejs) vía CDN, así el
  secreto nunca se envía a un tercero.
- Notificaciones push usan la librería [`web-push`](https://github.com/web-push-libs/web-push)
  (única dependencia npm del proyecto) para el cifrado del protocolo Web Push
  (RFC 8291/8292) — reimplementarlo a mano es criptografía de alto riesgo.
- Credenciales OAuth de Google si quieres probar el login (ver abajo).
- Opcional: VAPID keys (push) y credenciales de Google Wallet Issuer
  (tarjeta de fidelidad) — ambas funciones se desactivan solas si no están
  configuradas, el resto de la app funciona igual.

## Configuración

Copia `.env.example` a `.env` (o exporta las variables) y completa:

```bash
PORT=3000
ADMIN_TOKEN=un-token-secreto
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
SOLES_PER_PUNTO=5
REWARD_THRESHOLD=50
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
GOOGLE_WALLET_ISSUER_ID=
GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL=
GOOGLE_WALLET_PRIVATE_KEY=
GOOGLE_WALLET_ORIGIN=http://localhost:3000
```

Para obtener las credenciales de Google: crea un proyecto en
[Google Cloud Console](https://console.cloud.google.com/apis/credentials),
crea un "OAuth 2.0 Client ID" de tipo *Web application* y agrega
`GOOGLE_REDIRECT_URI` como *Authorized redirect URI*. Sin estas variables,
`/auth/google` responde con un error explicando que falta configurar el login.

Para las **notificaciones push**, genera un par de claves VAPID una sola vez:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Para el botón **Agregar a Google Wallet**, necesitas una cuenta de
[Google Wallet Issuer](https://developers.google.com/wallet/generic/getting-started)
y una service account con la Google Wallet API habilitada (el JSON de la
service account te da `client_email` y `private_key`). Ninguna de las dos
integraciones es necesaria para que el resto de la app funcione: si faltan
las variables, el botón/las notificaciones simplemente no aparecen (el
backend responde con un error claro si se llama igual al endpoint).

## Ejecutar en local

```bash
npm start
```

`npm start` compila TypeScript automáticamente (`prestart` corre
`npm run build`, que es `tsc`) y después arranca `node dist/server.js`. El
servidor levanta en `http://localhost:3000` (o el puerto indicado por la
variable de entorno `PORT`). Para desarrollo con recompilación en caliente:
`npm run dev` (`tsc --watch`) en una terminal y `node dist/server.js` en otra.

## Cómo funciona

El código fuente vive en `src/` (TypeScript); `tsc` lo compila a `dist/`
(JavaScript plano, con source maps), que es lo que realmente se ejecuta.
`public/` (HTML/CSS/JS vanilla del navegador) no pasa por este build —
sigue siendo JavaScript simple sin bundler, a propósito.

- `src/server.ts`: servidor HTTP que sirve `public/` y expone toda la API.
- `src/db.ts`: acceso a SQLite (`data/suscripciones.sqlite`, se crea sola y no
  se versiona en git). Tablas: `subscribers` (pre-registro), `users`,
  `sessions`, `purchases`, `points_ledger`, `family_groups`, `products`,
  `promotions`, `promotion_products`, `promotion_codes`,
  `promotion_redemptions`, `push_subscriptions`, `profile_fields` +
  `user_profile_values` (campos de perfil dinámicos, ver más abajo).
  Corre en modo **WAL** (`PRAGMA journal_mode = WAL`, lecturas y escrituras
  no se bloquean entre sí) con `busy_timeout = 5000` (una escritura que
  choca con otra espera hasta 5s en vez de fallar al toque). Índices en
  todas las columnas por las que se filtra seguido (`user_id`,
  `family_group_id`, `referred_by`, etc.). Los listados del admin
  (grupos familiares, promociones) traen los datos relacionados de toda
  la página en una sola consulta extra en vez de una por fila.
- `src/auth/google.ts`: flujo OAuth2 con Google (authorization code + verificación
  del `id_token` vía el endpoint `tokeninfo` de Google).
- `src/auth/totp.ts`: generación y verificación de códigos TOTP (RFC 6238) para
  el segundo factor, con `node:crypto` puro.
- `src/auth/push.ts`: envío de notificaciones Web Push (usa `web-push` para el
  cifrado VAPID/aes128gcm).
- `src/auth/googleWallet.ts`: construye y firma (RS256) el JWT "Save to Google
  Wallet" con la tarjeta de fidelidad del cliente, y además llama a la
  **Wallet REST API** (con un access token de service account) para tres
  cosas más: actualizar el saldo de estrellas en el pase que el cliente ya
  guardó (cada vez que compra, canjea puntos o gana un referido — no hace
  falta que vuelva a la web para ver el saldo nuevo), empujarle un mensaje
  al pase guardado cuando se activa una promoción (aparece como
  notificación dentro de la propia app de Google Wallet, además del push
  del navegador), y actualizar la **imagen grande (heroImage)** del pase
  con la foto de la promo activa, si tiene una. Todo esto es mejor
  esfuerzo: si el cliente nunca guardó el pase, la API responde 404 y
  simplemente se ignora.
- `public/index.html`: formulario de pre-registro.
- `public/cuenta.html`: sesión del cliente — login con Google, activación de
  2FA con QR, saldo de estrellas con barra de progreso, canje de puntos,
  historial de consumo, código de referido, grupo familiar, banner de
  promociones (con foto, vigencia y productos), un campo para **canjear un
  código de promoción**, activar notificaciones push y agregar a Google Wallet.
- `public/admin.html`: panel de administrador (protegido por `ADMIN_TOKEN`)
  con tráfico de consumo por hora/día, usuarios y su wallet (con buscador y
  exportación CSV), referidos, grupos compartidos, compras (+ formulario
  para registrar una nueva), **catálogo de productos** (nombre, foto, precio),
  **promociones** (título, mensaje, foto, vigencia, productos asociados,
  código de publicación autogenerado, códigos de canje con etiqueta/límite
  de usos, envío push) y la lista de pre-registro.
- `public/sw.js`: service worker que muestra las notificaciones push.

## Flujo de login y 2FA

1. El cliente entra a `/cuenta.html` y pulsa **Continuar con Google**.
2. Tras el consentimiento de Google, si es su primer login se le pide
   **configurar 2FA**: se muestra un QR (secreto TOTP) para escanear con
   Google Authenticator/Authy y debe confirmar un código de 6 dígitos.
3. En logins posteriores, tras el login de Google se le pide **el código de
   6 dígitos** de su app (segundo factor obligatorio).
4. Solo entonces la sesión queda `active` y puede ver su wallet.

Las sesiones se guardan como tokens opacos en la tabla `sessions` (cookie
`sid`, `HttpOnly`, `SameSite=Lax`, `Secure` cuando la conexión es HTTPS).

## Modelo de promociones

Cada **promoción** tiene:

- Título, mensaje y una foto (URL — no hay subida de archivos, se pega el
  link de una imagen ya alojada en algún lado, igual que la foto de perfil
  de Google).
- **Vigencia**: `starts_at` / `ends_at` opcionales; fuera de ese rango, o con
  `active = 0`, deja de aparecer en `/api/promotions` y en el banner del
  cliente.
- **Productos o conjuntos de productos**: se asocian desde un catálogo
  (`products`, gestionado en la pestaña *Productos* del admin) vía la tabla
  `promotion_products`.
- **Código de publicación** (`publication_code`, ej. `PROMO-0007`): un
  identificador interno autogenerado para administrar/editar la promoción,
  **no** es lo que canjea el cliente.
- **Códigos de canje** (`promotion_codes`): uno o varios códigos que el
  cliente sí canjea, cada uno con su propia etiqueta (ej. "Sucursal Centro",
  "Tanda 1") y límite de usos opcional. Se agregan desde el admin dentro de
  cada promoción. El cliente los canjea desde `/cuenta.html` con
  `POST /api/promotions/redeem`, que valida vigencia y límite de usos y
  registra el canje en `promotion_redemptions`. El endpoint público
  `GET /api/promotions` **no** expone estos códigos (evita que cualquier
  usuario con sesión vea los códigos pensados para otro canal/sucursal);
  el cliente necesita conseguir el código por donde se distribuya (flyer,
  redes, etc.).

La promoción vigente más reciente se muestra como **popup** apenas se carga
`/` (landing pública, sin login) o `/cuenta.html`. El popup se cierra y no
vuelve a aparecer una vez visto (se recuerda por `publication_code` en
`localStorage` del navegador); una promoción nueva sí se muestra de nuevo.

## API — suscripción pre-apertura

- `POST /api/subscribe` — Body `{ nombre, telefono, dni, unasam }`.
- `GET /api/subscribe/count` — Total de registrados.
- `GET /api/admin/subscribers` — Lista completa (header `x-admin-token`).

## API — cuenta / wallet (requiere sesión, cookie `sid`)

- `GET /auth/google` — Inicia el login (acepta `?ref=CODIGO` para asociar un
  referido).
- `GET /auth/google/callback` — Callback OAuth.
- `POST /api/logout`
- `GET /api/me` — Estado de la sesión (`authenticated`, `stage`, perfil,
  incluye `tier` — nivel de fidelidad — y `spinStatus` — disponibilidad de
  la ruleta de premios). `stage: 'needs_profile'` significa que falta
  vincular DNI/celular — se pide antes que el 2FA, una sola vez.
- `POST /api/profile/complete` — Body `{ dni, telefono }`. Vincula DNI
  (8 dígitos) y celular peruano (9 dígitos, empieza con 9) a la cuenta.
  409 si el DNI ya está vinculado a otro usuario.
- `stage: 'needs_extra_fields'` en `/api/me` — falta llenar un **campo de
  perfil dinámico** marcado como obligatorio (ver más abajo); trae
  `fields: [{ id, field_key, label, field_type }]` con lo que falta.
- `POST /api/profile/fields` — Body `{ values: { <fieldId>: valor, ... } }`.
  Guarda uno o más valores de campos dinámicos (sirve tanto para completar
  el gate obligatorio como para editar campos opcionales en cualquier
  momento desde la tarjeta "Tu información" de `cuenta.html`). Devuelve
  `items` con todos los campos activos y su valor actual.
- `POST /api/2fa/setup` — Genera el secreto TOTP y la URL `otpauth://` para
  el QR (solo en primer login).
- `POST /api/2fa/verify` — Body `{ code }`. Confirma el 2FA (setup o login).
- `GET /api/purchases?page=&limit=` — Historial de consumo propio, paginado.
- `POST /api/points/redeem` — Body `{ puntos, motivo }`. Canjea estrellas.
- `GET /api/wallet/spin` — Estado de la ruleta de premios (`available`,
  `nextSpinAt`, `cooldownHours`).
- `POST /api/wallet/spin` — Gira la ruleta (1 vez cada `SPIN_COOLDOWN_HOURS`,
  default 24h; 429 si aún no toca). Otorga un premio ponderado al azar
  (0 a 50 estrellas) y devuelve `{ prize, balance, spinStatus }`.
- `POST /api/family/create` — Body `{ name }`. Crea grupo familiar/compartido.
- `POST /api/family/join` — Body `{ inviteCode }`. Se une a un grupo.
- `POST /api/family/leave` — Sale del grupo. Si el que sale es el dueño, el
  grupo se disuelve para todos (no hay a quién transferirlo).
- `POST /api/family/remove-member` — Body `{ userId }`. Solo el dueño puede
  expulsar a otro miembro.
- `POST /api/logout-all` — Cierra la sesión actual y todas las demás abiertas
  del usuario (otros dispositivos/navegadores).
- `GET /api/promotions` — Promociones activas y vigentes (público, no
  requiere sesión — se usa tanto en `/` como en `/cuenta.html` para mostrar
  el popup/banner). No incluye los códigos de canje.
- `POST /api/promotions/redeem` — Body `{ code }`. Canjea un código de
  promoción (requiere sesión activa); valida vigencia y límite de usos.
- `GET /api/wallet/google-pass` — Devuelve `{ saveUrl }` para el botón
  "Agregar a Google Wallet" (501 si no está configurado).
- `GET /api/push/vapid-public-key` — Clave pública VAPID (no requiere sesión).
- `POST /api/push/subscribe` — Body: objeto `PushSubscription` del navegador.
- `POST /api/push/unsubscribe` — Body `{ endpoint }`.

## API — administrador (header `x-admin-token`)

- `POST /api/admin/purchases` — Body `{ email, monto, producto }`. Registra
  una compra/consumo del cliente (por su email de Google) y le suma
  estrellas (`monto / SOLES_PER_PUNTO`, redondeado hacia abajo).
- `GET /api/admin/purchases?page=&limit=&q=` — Todas las compras, paginado y
  filtrable por cliente/producto.
- `GET /api/admin/users?page=&limit=&q=` — Usuarios con su saldo de estrellas,
  gasto total y estado de 2FA, paginado y filtrable por nombre/email.
- `GET /api/admin/referrals?page=&limit=&q=` — Usuarios afiliados/referidos y
  quién los refirió, paginado y filtrable.
- `GET /api/admin/family-groups?page=&limit=` — Grupos familiares/compartidos
  con sus miembros, paginado.
- `GET /api/admin/stats/traffic` — Conteo de compras por hora del día (0-23)
  y por día de la semana, para ver horarios/tráfico pico.
- `GET /api/admin/promotions?page=&limit=` — Promociones publicadas
  (activas e inactivas), con sus productos y códigos de canje.
- `POST /api/admin/promotions` — Body
  `{ title, body, photoUrl, startsAt, endsAt, productIds, confirmDuplicate }`.
  Crea una promoción (aparece como popup/banner en `/` y `/cuenta.html`
  según su vigencia) y genera el `publication_code`. Si ya existe una
  promoción **activa** con el mismo título, responde 409 con
  `{ duplicate: true, existingPromotion }` a menos que se mande
  `confirmDuplicate: true`. Si `startsAt` es hoy/pasado o viene vacío, la
  envía por push (navegador + Google Wallet) de inmediato; si es una fecha
  futura, queda **programada** (`scheduled: true` en la respuesta) y el
  push se dispara solo cuando llegue el día — ver "Promociones programadas"
  abajo.
- `POST /api/admin/promotions/deactivate` — Body `{ id }`. Deja de mostrarla.
- `POST /api/admin/promotions/update` — Body
  `{ id, title, body, photoUrl, startsAt, endsAt, productIds }` (todos
  opcionales salvo `id`). Edita una promoción existente.
- `POST /api/admin/promotions/delete` — Body `{ id }`. Borrado real; falla
  con un mensaje claro si la promoción ya tiene canjes registrados (en ese
  caso hay que desactivarla en vez de borrarla, para no perder el historial).
- `POST /api/admin/promotions/codes` — Body
  `{ promotionId, code, label, maxUses }`. Agrega un código de canje a la
  promoción (si `code` viene vacío, se genera uno al azar).
- `GET /api/admin/promotions/summary` — Resumen general: promociones
  activas, clientes en la wallet, cuántos canjearon alguna promoción,
  cuántos nunca canjearon, tasa de canje.
- `GET /api/admin/promotions/redeemers?id=` — Quién canjeó una promoción
  específica (nombre, email, código usado, fecha).
- `GET /api/admin/promotions/non-redeemers?id=&page=&limit=&q=` — Quién NO
  canjeó ningún código de esa promoción todavía, paginado y con búsqueda
  por nombre/correo (el complemento de `redeemers`).
- `GET /api/admin/reports/top-customers?page=&limit=&q=&minCompras=&sortBy=`
  — Clientes ordenados por compras, gasto total o frecuencia
  (`sortBy`: `num_compras` | `total_gastado` | `comprasPorSemana`).
- `GET /api/admin/reports/recurring-promo-customers?page=&limit=&q=` —
  Clientes ordenados por cuántas promociones *distintas* canjearon.
- `GET /api/admin/products?page=&limit=` — Catálogo paginado.
- `GET /api/admin/products/active` — Catálogo activo sin paginar (para el
  selector de productos al crear una promoción).
- `POST /api/admin/products` — Body `{ name, photoUrl, price }`.
- `POST /api/admin/products/deactivate` — Body `{ id }`.
- `POST /api/admin/products/update` — Body `{ id, name, photoUrl, price }`.
- `POST /api/admin/products/delete` — Body `{ id }`. Borrado real; falla si
  el producto está asociado a alguna promoción (desactivarlo en ese caso).
- `GET /api/admin/profile-fields` — Lista todos los campos de perfil
  dinámicos (activos e inactivos).
- `POST /api/admin/profile-fields` — Body `{ key, label, type, required }`.
  Crea un campo nuevo (`type`: `text` | `number` | `date`). 409 si la
  clave ya existe.
- `POST /api/admin/profile-fields/update` — Body `{ id, label, type,
  required, active }` (todos opcionales salvo `id`).
- `POST /api/admin/profile-fields/delete` — Body `{ id }`. Borrado real;
  falla si algún cliente ya tiene un valor guardado en ese campo
  (desactivarlo en ese caso, no se pierde lo ya recolectado).
- `POST /api/admin/users/force-logout` — Body `{ email }`. Cierra la sesión
  de ese cliente en todos sus dispositivos (celular perdido/robado, cuenta
  comprometida, etc.).
- `GET /api/admin/export/users.csv` — Exporta todos los usuarios a CSV.
- `GET /api/admin/export/purchases.csv` — Exporta todas las compras a CSV.
- `GET /api/admin/export/referrals.csv` — Exporta todos los referidos a CSV.

```bash
ADMIN_TOKEN=un-token-secreto npm start
curl -H "x-admin-token: un-token-secreto" \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"cliente@gmail.com","monto":25,"producto":"Frappé"}' \
  http://localhost:3000/api/admin/purchases
```

## Referidos

Cuando alguien se registra usando el enlace de referido de otro cliente
(`?ref=CODIGO`), al vincularse la cuenta se pagan dos bonos de una sola vez
(no se repiten si el mismo referido se "re-vincula"):

- `REFERRAL_BONUS_POINTS` (default 20) para quien refirió.
- `REFERRAL_WELCOME_POINTS` (default 10) para el que se registró.

Poner cualquiera de las dos en `0` la desactiva.

## Seguridad

- **Bloqueo de intentos de 2FA**: tras `TOTP_MAX_ATTEMPTS` códigos
  incorrectos seguidos (default 5) la sesión queda bloqueada
  `TOTP_LOCKOUT_MINUTES` minutos (default 5) antes de poder reintentar. El
  contador se guarda por sesión en la tabla `sessions` y se resetea al
  acertar.
- **Rate limiting** en memoria (por IP) sobre los endpoints más sensibles a
  abuso: `/api/subscribe` (10/hora), `/api/2fa/verify`, `/api/points/redeem`
  y `/api/promotions/redeem` (20 cada 5 min). Es de un solo proceso —
  suficiente para esta app, que ya corre con SQLite de un solo proceso; con
  varias réplicas cada una lleva su propio conteo.
- **Revocación de sesiones**: el cliente puede cerrar sesión en todos sus
  dispositivos desde `/cuenta.html`, y el admin puede forzarlo desde
  `/admin.html` (ej. celular perdido/robado, sospecha de cuenta comprometida).
- Las cookies de sesión son `HttpOnly`, `SameSite=Lax`, y `Secure` cuando la
  conexión llega por HTTPS.
- El endpoint público `GET /api/promotions` nunca expone los códigos de
  canje de una promoción (ver "Modelo de promociones" arriba).
- **XSS**: todo dato que el cliente controla (nombre de grupo familiar,
  nombre/email de usuario — viene de Google, no sanitizado por ellos —,
  título/cuerpo de promo, nombre de producto, valores de campos de perfil,
  etc.) se escapa con `escapeHtml()` antes de insertarse con `innerHTML` en
  `admin.html`, `cuenta.html` e `index.html`. El caso más directo era el
  nombre de un grupo familiar (el cliente lo escribe él mismo, sin filtro)
  — un nombre con código podía llegar a ejecutarse en la pantalla del
  administrador al abrir la pestaña "Compartidos". Verificado con
  Playwright creando un grupo con un payload real: se confirma que se
  muestra como texto plano y no se ejecuta nada.
- **Condiciones de carrera**: canjear puntos, canjear un código de promoción
  con límite de usos, y girar la ruleta, antes revisaban una condición y
  escribían el resultado en dos pasos separados — inofensivo en un solo
  proceso, pero una base fragil de cara a escalar a más de un proceso o
  réplica. Ahora cada uno es **una sola sentencia SQL atómica**
  (`INSERT ... WHERE saldo >= X` / `UPDATE ... WHERE usos < max_usos`), así
  que el límite se respeta exacto sin importar cuántos procesos compartan
  la base. Verificado con una prueba de 10 clientes canjeando el mismo
  código con `max_uses: 3` en la misma ráfaga: exactamente 3 se aceptan,
  el resto recibe `CODE_EXHAUSTED`.

## Tests

Sin dependencias externas — usa el test runner nativo de Node
(`node:test` + `node:assert`), escritos en TypeScript (`src/test/*.test.ts`).
Cada archivo de test usa su propia base de datos temporal (vía la variable
`DB_FILE`, que sobreescribe la ruta por defecto de
`data/suscripciones.sqlite`) para no tocar datos de desarrollo.

```bash
npm test
```

`npm test` compila primero (`pretest` → `tsc`) y después corre
`node --test` sobre los `.js` ya compilados en `dist/test/`.

Cubre: TOTP (generar/verificar/tolerancia de reloj), rate limiting,
referidos (bono único), grupo familiar (crear/unirse/expulsar/salir),
productos y promociones (crear/editar/borrado bloqueado si están en uso),
canje de código (vigencia, límite de usos), compras y progreso de
recompensa, y bloqueo/reseteo de intentos de 2FA.

## CI

`.github/workflows/ci.yml` corre en cada push/PR: compila TypeScript
(`npm run build` — esto también es el chequeo de tipos, ya que `tsc` falla
si hay un error de tipos), corre los tests contra el `.js` compilado, y
levanta el servidor real para un smoke test (`GET /`, `/cuenta.html`,
`/admin.html` y `/api/subscribe/count`).

## Docker

```bash
cp .env.example .env   # completar con tus valores
docker compose up --build
```

El `Dockerfile` compila en dos etapas: la primera (`node:22-slim`) instala
todas las dependencias (incluida `typescript`) y corre `tsc`; la segunda
copia solo el `dist/` ya compilado y `public/`, e instala únicamente
dependencias de producción (`npm ci --omit=dev` — `typescript` nunca llega
a la imagen final). También monta un volumen (`desencajado_data`) para
`data/` — la base SQLite sobrevive a recrear el contenedor. El puerto por
defecto es `3000` (cambiar el mapeo en `docker-compose.yml` para usar otro
puerto de host).

**Backup de la base de datos**: `src/scripts/backup.ts` usa `VACUUM INTO` de
SQLite para sacar una copia consistente sin parar el servidor (evita el
riesgo de copiar el archivo `.sqlite` a mano mientras hay una escritura en
curso):

```bash
# En local
npm run backup                       # compila y guarda en data/backups/

# Contra el contenedor (ejecuta el script ya compilado, tiene acceso al volumen)
docker compose exec app node dist/scripts/backup.js
```

No hay backups automáticos/programados — conviene agregar un cron (en el
host, o un contenedor aparte) que corra ese comando periódicamente y suba
el resultado a almacenamiento externo (S3, etc.) si esto va a producción real.

## Reportes y duplicidad de promociones

**Duplicidad**: al publicar una promoción, si ya existe una **activa** con
el mismo título (sin importar mayúsculas, tildes o espacios), el admin
recibe un aviso con la fecha de la que ya existe y debe confirmar
explícitamente ("¿Publicar de todas formas?") antes de seguir — evita que
un doble clic o un olvido publique la misma promo dos veces. La comparación
se hace en JavaScript, no con `LOWER()` de SQLite, porque esa función solo
pliega mayúsculas ASCII (no reconocería "FRAPPÉS" como igual a "frappés").

**Pestaña "Reportes"** en el admin:
- Resumen: promociones activas, clientes en la wallet, cuántos canjearon
  alguna promoción alguna vez, cuántos nunca canjearon, tasa de canje
  global.
- **Top clientes por compras**: nombre, número de compras, total gastado,
  compras por semana (calculado entre su primera y su última compra — con
  una sola compra no hay ventana de tiempo real, así que se muestra `—`).
  Filtro personalizable: buscar por nombre/email, mínimo de compras para
  aparecer en la lista, y ordenar por compras / gasto / frecuencia.
- **Clientes recurrentes en promociones**: cuántas promociones *distintas*
  canjeó cada cliente (no cuántas veces en total) — para identificar a
  quienes repiten, no solo a quienes canjearon mucho una sola vez.

**En la pestaña Promociones**, cada promoción ahora muestra "canjeada por
N cliente(s)" y dos botones: **Ver quiénes canjearon** (nombre, email,
código usado, fecha) y **Ver quiénes NO canjearon** — este último paginado
y con búsqueda por nombre/correo, porque la lista de quienes faltan por
canjear puede acercarse al total de clientes.

**Envío a Google Wallet en tandas**: al activar una promoción (de
inmediato o cuando le toca por el scheduler), el mensaje y la imagen
destacada de Google Wallet se envían en segundo plano con un máximo de 5
llamadas simultáneas a la API de Google (`runInBatches` en `src/server.ts`),
en vez de un `Promise.all` sin límite que golpearía a Google con cientos
de llamadas a la vez. La respuesta al admin ya no espera a que termine ese
envío — `walletPushQueued` indica cuántos quedaron encolados, no cuántos
ya se confirmaron entregados (los errores individuales solo se registran
en el log del servidor).

## Roadmap: envío de campañas por WhatsApp (planeado, no implementado)

Hoy una promoción se publica por tres canales: popup en la web, notificación
push del navegador, y mensaje al pase de Google Wallet ya guardado (ver
`src/auth/googleWallet.ts`). **No hay integración de WhatsApp** — quedó
pendiente a propósito, porque la opción correcta depende de una decisión de
negocio (verificación con Meta, costo por mensaje) y no solo de código.
Opciones evaluadas para cuando se decida implementarlo:

| Opción | Costo | Setup | Notas |
|---|---|---|---|
| **WhatsApp Cloud API (Meta)** | Gratis hasta cierto volumen mensual | Requiere verificar el negocio en Meta Business Manager y que Meta apruebe una plantilla de mensaje para envíos "fuera de sesión" (como una promo) | Opción recomendada a mediano plazo si el volumen de clientes crece |
| **Twilio (WhatsApp Business API)** | De pago desde el primer mensaje | Setup más simple, todo vía API key de Twilio | Útil si se quiere probar rápido sin pasar por la verificación de Meta |
| **Link `wa.me` manual** | Gratis | Ninguno | No es envío masivo automático: cada promo generaría un link `wa.me/<numero>?text=...` que el negocio comparte a mano (ej. en un estado de WhatsApp) |

**Actualización**: el teléfono ya está vinculado a `users` (ver "Paso 1 de 2"
del onboarding, arriba) — el prerequisito de datos para esto ya no falta.
Sigue pendiente: elegir proveedor (tabla arriba) y, antes de mandar cualquier
campaña, agregar un **opt-in explícito de marketing** (una casilla en el
formulario de perfil tipo "Acepto recibir promociones por WhatsApp/SMS") —
al tratarse ahora de datos identificados (DNI + celular, no un registro
anónimo), conviene pedir consentimiento explícito para ese uso antes de
enviar nada, en línea con la Ley de Protección de Datos Personales (Ley
29733). Lo mismo aplica el día que se pida fecha de nacimiento para la
promo de cumpleaños: pedirla junto con su propio opt-in, no reusar el
consentimiento de WhatsApp para otro fin.

**Actualización 2**: ya existe el mecanismo para pedir la fecha de
nacimiento (y cualquier otro dato futuro) sin escribir código — ver
"Campos de perfil dinámicos" abajo. Falta: crear el campo `fecha_nacimiento`
desde el admin cuando se decida activarlo, y el propio envío de la promo de
cumpleaños (hoy nada lee `user_profile_values` para mandar nada — el dato
se recolecta pero aún no dispara ninguna campaña automática).

## Promociones programadas

Una promoción se puede crear hoy con una fecha de inicio futura para que
quede lista y se publique sola más adelante:

- Si `startsAt` es hoy o ya pasó (o se deja vacío), se activa **de
  inmediato**: se manda el push del navegador y el mensaje + imagen a
  Google Wallet en el momento de crearla, igual que antes.
- Si `startsAt` es una fecha futura, la promoción queda guardada
  (`scheduled: true` en la respuesta del admin) sin avisarle a nadie
  todavía. El popup/banner tampoco la muestra hasta esa fecha (esto ya
  existía). La columna `activated_at` queda en `NULL` mientras espera.
- Un scheduler interno (`runPromotionScheduler` en `src/server.ts`) revisa las
  promociones pendientes **una vez al arrancar el servidor y luego una vez
  al día** — la programación es por **día**, no por hora todavía (no tiene
  sentido revisar más seguido si la granularidad es diaria). Apenas
  encuentra una cuya fecha ya llegó, dispara el mismo push que se manda al
  crear una inmediata (`activatePromotion`, compartida por los dos casos)
  y marca `activated_at`.
- Editar/desactivar una promoción programada no la reactiva ni la
  vuelve a enviar — `activated_at` solo se pisa una vez.
- Migración: las promociones que ya existían antes de este cambio se
  backfillean con `activated_at = created_at` la primera vez que arranca
  el servidor con la columna nueva, para que el scheduler no les vuelva a
  mandar push a todo el mundo por error.

Panel admin: cada promoción muestra si está "📅 Programada — se enviará
el `<fecha>`" o "✅ Enviada el `<fecha>`".

## Campos de perfil dinámicos

Para pedir cualquier dato adicional al cliente en el futuro (fecha de
nacimiento, un número de referencia, lo que sea) sin necesitar una
migración de columna ni un despliegue nuevo:

- El admin crea el campo desde la pestaña **Campos de perfil**: una
  etiqueta (lo que ve el cliente), una clave interna, un tipo
  (texto/número/fecha) y si es obligatorio.
- Si es **obligatorio**, la próxima vez que el cliente entre a
  `/cuenta.html` (`GET /api/me` devuelve `stage: 'needs_extra_fields'`) se
  le pide antes de dejarlo continuar — aplica incluso a cuentas que ya
  estaban activas antes de crear el campo.
- Si es **opcional**, aparece en la tarjeta "Tu información" de la wallet,
  donde el cliente lo puede llenar o actualizar cuando quiera.
- Editar o desactivar un campo no borra los datos ya recolectados; borrarlo
  de verdad solo se permite si ningún cliente tiene un valor guardado ahí
  (`PROFILE_FIELD_IN_USE` en caso contrario).
- Los valores se guardan en `user_profile_values` (`user_id`, `field_id`,
  `value` como texto plano) — quien construya una campaña futura (ej.
  cumpleaños) necesita leer esa tabla directamente; no hay todavía ninguna
  automatización que lo haga.
