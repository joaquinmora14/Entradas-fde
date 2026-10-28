# Invitaciones · Fiesta de Egresados

Aplicación web para que cada egresado **anote a qué mails les dio sus entradas** (16 por persona) y así ningún mail
se repita entre egresados. La app no envía nada a los invitados: es un registro compartido. Incluye un pool común de
"Personas fuera de lista", panel público de cupos, panel de administración y exportación automática a Google Sheets.

- **Producción:** https://entradas-fde.vercel.app
- **Cupos públicos:** https://entradas-fde.vercel.app/cupos
- **Stack:** Next.js 16 (App Router, Server Actions) · PostgreSQL (Neon) · Vercel · API oficial de Google Sheets

---

## Cómo funciona

| Concepto | Regla |
|---|---|
| Identidad de un invitado | Su **email normalizado** (minúsculas, sin espacios; en Gmail se ignoran puntos y `+sufijo`). Único en toda la app. |
| Cupo individual | 16 entradas por egresado. Cada persona anotada descuenta exactamente 1. |
| Grupos | La gente pide entradas en grupo (un mensaje con varias personas que van juntas). Todos los mails de un mismo mensaje forman **un grupo**: se anotan **todos juntos o ninguno** (si no alcanzan las entradas o si a alguno lo anotó otro egresado mientras se revisaba, no se anota a nadie). Los mails que ya tienen entrada, inválidos o de egresados se avisan y quedan afuera. |
| Pool “Fuera de lista” | Lista común que pueden ver y ampliar todos los egresados (y el admin), **por grupos** y ordenada por antigüedad (los primeros cargados arriba). Cada egresado **elige un grupo** y les da una entrada a todos sus integrantes (descuenta 1 por persona de sus 16), o a ninguno. Un grupo puede tener hasta 16 personas. Si dos eligen el mismo grupo a la vez, solo uno se lo queda entero. |
| Fuente de verdad | PostgreSQL. Google Sheets es una copia operativa que se sincroniza sola. |
| Planilla | Hoja **Invitados** con exactamente dos columnas: `Invitado` (email) e `Invitado por` (nombre del egresado). Una fila por invitado. |

### Garantías de consistencia

- **Unicidad global:** índice único parcial `invitations(guest_email_normalized) WHERE status = 'active'`. Dos egresados
  que invitan al mismo email al mismo tiempo producen como máximo una invitación (además se serializa por email con un
  `pg_advisory_xact_lock`).
- **Cupo atómico:** un trigger descuenta la entrada en la **misma transacción** que crea la invitación y una restricción
  `CHECK (used <= initial_quota)` impide superar el cupo, incluso con solicitudes simultáneas. Si algo falla, no se
  descuenta nada.
- **Grupos atómicos:** un grupo se anota en una sola transacción (todas las invitaciones comparten `group_id`); los
  mails se bloquean siempre en el mismo orden para que dos grupos simultáneos no se traben.
- **Pool atómico:** las personas del grupo elegido se bloquean con `SELECT … FOR UPDATE` y se marcan asignadas en la misma
  transacción que crea las invitaciones. Si la transacción falla, sigue disponible. Una persona asignada nunca vuelve a
  estar disponible (trigger) y no puede reimportarse (email único en el pool).
- **Idempotencia:** cada envío de formulario lleva una clave única. Reintentar (doble toque, corte de red) devuelve
  el mismo resultado sin crear otra invitación ni asignar otra persona.
- **Outbox transaccional:** al crear o anular una invitación, un trigger inserta una tarea en `app.sheet_sync_jobs`
  dentro de la misma transacción. Si el servidor se reinicia o Google está caído, la tarea queda guardada.
- **Reintentos sin duplicados:** antes de escribir, el sincronizador **lee la hoja** y solo agrega los emails que no
  están. Si una escritura anterior llegó a Google pero la respuesta se perdió, el reintento la detecta y no la repite.
  Un *lease* en la base garantiza que un solo proceso escriba a la vez. Espera progresiva: 15 s, 30 s, 60 s… hasta 30 min.
- **Disparadores de la sincronización** (no dependen de que nadie tenga el navegador abierto):
  1. Inmediatamente después de cada invitación (la respuesta dice si quedó en la planilla o pendiente).
  2. GitHub Actions cada 5 minutos (`.github/workflows/sheets-sync.yml` → `POST /api/sync/kick`).
  3. Al cargar el panel o los cupos (después de responder, con `after()`).
  4. Vercel Cron diario con reconciliación completa (`/api/cron/sync?reconcile=1`, protegido con `CRON_SECRET`).
  5. Botón “Sincronizar pendientes ahora” en Admin → Planilla.
- **Reconciliación:** Admin → Planilla → “Comparar” muestra faltantes, duplicados, nombres incorrectos y filas sin
  invitación; “Reconciliar” deja la hoja idéntica a la base sin tocar las invitaciones.

## Uso

### Egresados
1. Entrar a https://entradas-fde.vercel.app/registro con el email que figura en la lista autorizada y crear la contraseña.
2. En **Mis entradas**: pegar el mensaje que les mandaron (nombre, mail, DNI… en cualquier formato), un grupo por vez →
   **Revisar mails**. La app extrae solo los mails, avisa cuáles ya tienen entrada, cuáles están repetidos y sugiere
   correcciones de tipeo (`gmail.con` → `gmail.com`). Después **Anotar el grupo**: se anotan todos juntos. En “Mails que
   anotaste” se ven agrupados, con **Copiar todos los mails**.
3. En **Fuera de lista**: ver la lista común por grupos, **sumar gente** pegando el mensaje tal como llegó (las personas de
   un mismo mensaje quedan como un grupo; no se agregan los que ya están ni los que ya tienen entrada), quitar a quien uno
   mismo cargó mientras nadie lo haya invitado, y **Darles mis entradas** al grupo que elija (una por persona). Después
   aparece una ventana que no se puede cerrar hasta tocar **Copiar los mails**.

**La app no envía nada a los invitados.** En cada paso (antes de pegar, al confirmar y después de anotar) se muestra un
aviso grande: quien anota un mail tiene que mandarle la invitación a esa persona. Después de anotar se listan los mails
con botones **Copiar** y **Copiar todos los mails**.

La extracción de mails es determinística (reglas, no IA): es exacta, instantánea, gratuita y los datos de los
invitados (nombres, DNI) no salen a ningún servicio externo. Entiende variantes como `juan arroba gmail punto com`.

### Administración (`/admin`)
- **Egresados:** importar la lista (CSV o texto `email,nombre`, el nombre es opcional), ver cuántas entradas le quedan
  a cada uno, renombrar, deshabilitar, quitar a quien todavía no se registró, y **generar enlaces de activación / nueva
  contraseña** (válidos 24 h, un uso).
- **Ficha de cada egresado** (tocar su nombre): entradas restantes y usadas, todos los mails que anotó, anular o
  corregir cada uno, y **anotar entradas en su nombre** (usa su cupo y queda auditado como hecho por el admin).
- **Invitaciones:** buscar, ver quién invitó a quién, **anular** (libera la entrada y quita la fila) o **corregir el email**
  (mantiene el cupo).
- **Pool:** ver los grupos, agregar pegando un mensaje (queda como un grupo) o por CSV (cada persona queda sola; informa
  agregados, duplicados, inválidos y rechazados por estar ya invitados), desactivar, reactivar o eliminar personas disponibles.
- **Planilla:** estado, tareas pendientes y errores, sincronización manual, comparación y reconciliación.
- **Auditoría:** registro de logins, registros, invitaciones, importaciones y correcciones.
- **Ajustes:** código de registro opcional (además de la lista autorizada).

**Quién es administrador:** los emails de la variable `BOOTSTRAP_ADMIN_EMAILS` (configurada en Vercel). Al registrarse o
iniciar sesión con uno de esos emails la cuenta queda como administradora. Nadie puede volverse admin desde el navegador.

**Recuperación de acceso:** si no hay proveedor de email configurado, el administrador genera un enlace personal desde
*Egresados → Acciones* y se lo envía a la persona. Opcionalmente, con `RESEND_API_KEY` + `EMAIL_FROM` los egresados
reciben el enlace por email desde `/recuperar`.

## Google Sheets: configuración

La planilla ya existe en el Drive del organizador (privada) y su ID está en `GOOGLE_SHEETS_SPREADSHEET_ID`.
Solo falta una **cuenta de servicio** de Google con permiso de edición:

1. Entrar a https://console.cloud.google.com/ → selector de proyectos → **Proyecto nuevo** (ej. `entradas-fde`) → Crear.
2. Habilitar la API: https://console.cloud.google.com/apis/library/sheets.googleapis.com → **Habilitar**.
3. **IAM y administración → Cuentas de servicio → Crear cuenta de servicio** (ej. `entradas-fde-sheets`). Sin roles → Listo.
4. Abrir la cuenta → **Claves → Agregar clave → Crear clave nueva → JSON**. Se descarga un archivo `.json`.
5. En Vercel → proyecto `entradas-fde` → **Settings → Environment Variables → Add**:
   `GOOGLE_SERVICE_ACCOUNT_JSON` = el contenido completo del archivo (Production y Preview, tipo *Sensitive*).
6. Compartir la planilla con el `client_email` de la cuenta de servicio (`…@….iam.gserviceaccount.com`) como **Editor**.
7. Redesplegar. Verificar en **Admin → Planilla → Comparar planilla con la base**.

Nunca subas el archivo JSON al repositorio (es público).

## Variables de entorno

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión con pooling (Neon `-pooler`) para la app. |
| `DATABASE_URL_MIGRATIONS` | Conexión directa para aplicar migraciones en el build. |
| `BOOTSTRAP_ADMIN_EMAILS` | Emails administradores, separados por coma. |
| `CRON_SECRET` | Protege `/api/cron/sync` (Vercel Cron lo envía automáticamente). |
| `APP_URL` | URL pública, para los enlaces de recuperación. |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ID de la planilla. |
| `GOOGLE_SHEETS_TAB` | Nombre de la hoja (por defecto `Invitados`). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON de la cuenta de servicio (texto o base64). |
| `RESEND_API_KEY`, `EMAIL_FROM` | Opcional: emails de recuperación. |

## Desarrollo local

```bash
npm install
# PostgreSQL local
export DATABASE_URL=postgres://usuario:clave@localhost:5432/fde_dev
npm run migrate
BOOTSTRAP_ADMIN_EMAILS=tu@email.com npm run dev
```

### Pruebas

```bash
export TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/fde_test   # se borra y recrea el esquema "app"
npm test
```

Las pruebas automatizadas corren contra un **PostgreSQL real** y usan una **hoja simulada en memoria** que puede
“caerse” o perder la respuesta después de escribir. Cubren autenticación, registro autorizado, normalización, cupos,
duplicados, concurrencia, idempotencia, errores sin descuentos, protección de rutas administrativas, panel público sin
emails, outbox con reinicio, caídas de Google, reintentos sin duplicados, reconciliación y todos los casos del pool.
La escritura real en Google Sheets se verifica en producción (ver “Google Sheets: configuración”).

**Fidelidad de los mails** (`tests/email-fidelity.test.ts`): un generador reproducible crea mails con todos los
caracteres válidos (puntos, `+`, `-`, `_`, `%`, apóstrofes, números, subdominios, mayúsculas) dentro de listas con
formatos reales (WhatsApp, tablas, formularios, DNI pegado, comillas, paréntesis…) y verifica que el mail sea idéntico
en la extracción, la revisión, la base, los paneles, el pool y la planilla. Para correr muchísimos más casos:
`FIDELITY_LISTS=60000 npx vitest run tests/email-fidelity.test.ts` (~300.000 mails por corrida).

## Estructura

```
migrations/           SQL versionado (se aplica en cada build con scripts/migrate.mjs)
src/server/           lógica de negocio (sin dependencias de Next): auth, invitaciones, pool, admin, sheets/
src/app/              páginas y Server Actions
src/components/       UI
tests/                pruebas (Vitest + PostgreSQL)
```

## Seguridad

- Contraseñas con **argon2id** (`@node-rs/argon2`); sesiones con token aleatorio en cookie `httpOnly`/`Secure`
  (`__Host-`), solo el hash se guarda en la base; límite de intentos de login por email e IP.
- Todo el esquema vive en `app`, no expuesto por ninguna API pública; los roles `anon`/`authenticated` no tienen acceso.
- Server Actions con verificación de origen (CSRF) de Next.js; los permisos se validan en el servidor en cada acción.
- El panel público solo expone nombre y números. La planilla es privada (compartida solo con la cuenta de servicio).
