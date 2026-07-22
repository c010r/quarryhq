# Changelog

## [1.7.0] — 2026-07-22

Versión enfocada en cerrar lo **fundacional del negocio**: facturación real,
búsqueda a escala y supervivencia de datos. Lo demás del análisis premium queda
documentado abajo como roadmap.

### Agregado

- **Stripe real** (`server/stripe.ts`, `server/index.ts`): nueva pasarela de
  pago. Sin la SDK oficial — sólo fetch a la REST API v1 de Stripe y
  verificación de webhook con HMAC-SHA256 (timing-safe, con tolerancia anti-
  replay de 5 min). Nuevos endpoints:
  - `POST /api/billing/upgrade` con Stripe responde `{mode:'stripe', url}` a
    Checkout. El metadata `user_id`+`plan` viaja hasta el webhook y se repite
    en las facturas recurrentes.
  - `POST /api/billing/portal` → Billing Portal de Stripe (gestionar tarjeta,
    ver facturas, cancelar).
  - `POST /api/billing/cancel` con Stripe responde 409 `use_portal` para
    preservar el período ya pagado; el webhook aplica la degradación al vencer.
  - `POST /api/billing/webhook` (raw body + firma) procesa
    `checkout.session.completed`, `invoice.payment_succeeded`,
    `invoice.payment_failed` (dunning + email) y
    `customer.subscription.deleted`.
  - `GET /api/billing/invoices` → historial cronológico de cobros (simulados y
    reales juntos).
  - Fallback simulado preservado: sin `STRIPE_SECRET_KEY` el flujo de 30 días
    sigue disponible en dev (`ALLOW_FAKE_BILLING=1` en prod, fuera por defecto).
- **Búsqueda full-text** (`server/db.ts`, `server/index.ts`): columnas
  `tsvector` precomputadas con triggers para `notes`, `cards`, `messages`,
  `channels`. Índices GIN. Pesado por campos (A=title, B=body) con
  `ts_rank_cd` para ranking y `ts_headline` para snippets resaltados. Soporta
  operadores `websearch_to_tsquery`: `"frase exacta"`, `OR`, `-excluir`.
  Backfill idempotente para bases existentes. Fallback `ILIKE` preservado para
  consultas muy cortas (donde tokenizar no aporta).
- **Backups off-site** (`deploy/backup-db.sh`): subida a cualquier bucket S3-
  compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO) con `aws-cli`.
  Encriptación AES-256 opcional pre-upload con `openssl`. Retención configurable
  (`BACKUP_RETENTION_DAYS`). Reducción graceful: sin `aws-cli`/credenciales, el
  dump local de 14 días sigue disponible para que `rclone`/restic lo suba.

### Cambiado

- `users.stripe_subscription_id` para trazar suscripciones reales.
- `payments` extendido con `stripe_invoice_id`, `stripe_subscription_id`,
  `invoice_url`, `hosted_invoice_url`, `status`, `period_start`, `period_end`.
- README actualizado con todo el setup nuevo (Stripe + backups + Customer Portal).

### Roadmap (no incluido en 1.7) — pendiente para 1.8+

Lo identificado en el análisis de brechas premium, documentado acá para que sea
trazable release por release:

#### Sprint 2 — expectativa premium
- **Email transaccional robusto**: preferencias de notificación, cola/reintentos,
  tracking de bounces.
- **Archivos adjuntos propios** con backend S3/R2 (`uploads` table, drag-and-drop
  en editor, sin depender de Google Drive).
- **Offline-first / PWA** instalable + CRDT/OT en edición simultánea de notas.
- **RBAC granular** + `commenter` + comentarios inline en tarjeta y nota
  (`card_comments` / `note_comments`).
- **Push notifications**: Web Push API + digest batching.

#### Sprint 3 — diferencial
- **AI / Copilot** (RAG propio): resumir nota, "convertí conversación en
  tarjetas", búsqueda semántica, auto-tags, draft de respuesta en chat.
- **Butler rico**: disparadores múltiples, condiciones, cross-board, cron.
- **Vistas**: Timeline/Gantt, dashboard con widgets (throughput, lead time,
  burndown), filtros guardados.
- **Integraciones**: GitHub/GitLab, iCal/Google Calendar export, Slack webhook,
  import desde Notion/Trello JSON.

#### Sprint 4 — escalar empresa
- **SSO/SAML**, 2FA/TOTP, passkeys, audit log visible, rate limiting por user.
- **Workspaces/organizaciones** aisladas, roles de administrador de equipo,
  billing consolidado.
- **Observabilidad**: Prometheus metrics, logs estructurados, Sentry.
- **i18n** EN/ES mínimo, formatos por locale.
- **Onboarding**: tour in-product, centro de ayuda, status page.

### Notas de despliegue

- Migración de base automática al arrancar (como siempre): `initSchema` cubre
  las nuevas tablas y columnas. Backfill FTS corre en cada arranque pero es
  idempotente y barato cuando ya está hecho.
- No hay dependencias nuevas: Stripe se consume por fetch nativo de Node 24;
  FTS vive en Postgres; backups usan `aws-cli`/`openssl` del sistema.
- Cliente `client/dist` se recompila en el VPS con `npm run build`.

---

## [1.69] — 2026-07-21

- UX/UI + a11y: focus trap en modales, glifo canónico, estados de carga/error,
  accesibilidad por teclado (`useModalA11y`).
- Sidebar: Notas pasa a ser un enlace único.
- Rediseño de lectura: editor y chat en columna centrada, fondo con profundidad.
- Rediseño visual: bienvenida con tarjetas de acción, sidebar con jerarquía,
  headers con chips.
- UX móvil: menú de acciones en notas, paneles laterales animados.
- Exportar notas como .md o PDF, con opción de incluir notas vinculadas.
- Alinear y redimensionar embeds de Google Drive en el editor.
- Insertar imágenes, video y PDFs desde Google Drive con scope mínimo `drive.file`.
- Grafo: las menciones `[[nota]]` en mensajes conectan canal y nota.
- Modo claro/oscuro y fondos de escritorio con fotos reales.
- Colaboración avanzada: roles, invitaciones por email, actividad, menciones
  y presencia.