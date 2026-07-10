# ⚡ Obstresla

SaaS de espacio de trabajo que combina lo mejor de tres herramientas, **todas vinculadas entre sí**:

| Herramienta | Inspirado en | Qué incluye |
|---|---|---|
| **Tableros** | Trello Premium | Kanban con drag & drop, etiquetas, **fechas de vencimiento**, **checklists**, **miembros asignados**, **vistas Tabla y Calendario**, **automatizaciones estilo Butler** |
| **Notas** | Obsidian + Sync | Markdown, `[[wiki-links]]`, backlinks, grafo, **historial de versiones con restauración**, **plantillas con variables**, **etiquetas #tag con filtrado**, **nota diaria** |
| **Chat** | Slack Pro | Canales en tiempo real (WebSockets), **hilos de respuesta**, **reacciones emoji**, **mensajes fijados**, **edición/borrado**, **mensajes programados** |

## Funcionalidades premium

- **Automatizaciones (Butler):** reglas por tablero — "cuando una tarjeta llegue a *Hecho* → marcarla completada / añadir etiqueta / fijar vencimiento". Se aplican automáticamente al mover tarjetas.
- **Vistas múltiples:** el mismo tablero como kanban, tabla ordenable (por lista, título, vencimiento, estado) o calendario mensual con las tarjetas en su fecha de vencimiento.
- **Historial de versiones:** cada edición de nota guarda un snapshot (fusionando ediciones de <2 min, máx. 30 versiones); se puede inspeccionar y restaurar cualquier versión.
- **Plantillas:** notas nuevas desde plantilla con variables `{{titulo}}` y `{{fecha}}`; cualquier nota puede guardarse como plantilla.
- **Hilos y reacciones:** conversaciones anidadas con contador de respuestas, reacciones emoji por usuario, mensajes fijados por canal.
- **Enviar más tarde:** los mensajes programados se entregan automáticamente (comprobación cada 15 s) y se pueden cancelar antes del envío.

## La vinculación es el producto

- **Tarjeta → Nota:** vincula notas a una tarjeta manualmente o escribiendo `[[Título]]` en su descripción.
- **Tarjeta → Chat:** cada tarjeta puede abrir su propio canal de discusión (`#tarjeta-…`) con un clic.
- **Chat → Nota:** escribe `[[Título]]` en un mensaje y queda registrado como mención (visible en los backlinks de la nota).
- **Nota → Nota:** wiki-links estilo Obsidian; si la nota no existe, se crea al hacer clic.
- **Backlinks:** cada nota muestra qué notas, tarjetas y mensajes la referencian.
- **Grafo de conocimiento:** visualización de fuerza de todos los nodos (notas, tarjetas, canales) y sus vínculos. Doble clic abre el elemento.
- **Búsqueda global (`Ctrl+K`):** busca en tarjetas, notas, mensajes y canales a la vez.

## Stack

- **Frontend:** React 18 + TypeScript + Vite (SPA, rutas por hash, CSS propio con tema oscuro)
- **Backend:** Node.js + Express + WebSockets (`ws`)
- **Base de datos:** **PostgreSQL 16** (driver `pg`, pool de conexiones). El esquema se crea solo al arrancar; los timestamps se guardan como texto UTC para compatibilidad de formato con el cliente.
- **Auth:** sesiones con token + contraseñas con `scrypt`, y **Google Sign-In** opcional (define `GOOGLE_CLIENT_ID` con un client id OAuth de Google Cloud y aparece el botón "Continuar con Google"; el servidor verifica el ID token contra `tokeninfo`)

## Desarrollo

Requisitos: Node 24+ y PostgreSQL corriendo. Por defecto conecta a
`postgres://postgres:postgres@localhost:5432/obstresla` — configurable con la variable `DATABASE_URL`.

Las variables se pueden definir en un `.env` en la raíz (ignorado por git), p. ej.:

```
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
```

```bash
# una sola vez: crear la base
psql -U postgres -c "CREATE DATABASE obstresla;"

npm install
npm run dev        # servidor API en :3001 + Vite en :5173
```

Abre http://localhost:5173, crea una cuenta y listo. El esquema y los datos de ejemplo (tablero "Producto", notas enlazadas, canales y plantillas) se crean automáticamente al arrancar si la base está vacía.

### Migración desde SQLite

Si vienes de la versión anterior con `data/obstresla.db`:

```bash
npm run migrate:sqlite   # copia todos los datos a PostgreSQL (aborta si PG ya tiene usuarios)
```

## Producción

```bash
npm run build      # compila el cliente a client/dist
npm start          # Express sirve API + estáticos en :3001 (o $PORT)
```

También hay `Dockerfile` (multi-stage, expone :3001) para plataformas de contenedores.

### Despliegue en VPS (obstresla.pro)

Plantillas listas en [`deploy/`](deploy/): bloque de nginx con proxy WebSocket,
unidad systemd y script de backup diario. Resumen en un VPS Ubuntu/Debian:

```bash
# 1. Node 24 + PostgreSQL 16
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install -y nodejs postgresql nginx certbot python3-certbot-nginx
sudo -u postgres psql -c "CREATE USER obstresla WITH PASSWORD '…';"
sudo -u postgres psql -c "CREATE DATABASE obstresla OWNER obstresla;"

# 2. App (usuario de sistema propio + .env con DATABASE_URL y GOOGLE_CLIENT_ID)
sudo useradd -r -m -d /opt/obstresla obstresla
sudo -u obstresla git clone https://github.com/c010r/obstresla.git /opt/obstresla
cd /opt/obstresla && sudo -u obstresla npm ci && sudo -u obstresla npm run build
sudo -u obstresla nano /opt/obstresla/.env   # DATABASE_URL=… GOOGLE_CLIENT_ID=…

# 3. Servicio + nginx + HTTPS
sudo cp deploy/obstresla.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now obstresla
sudo cp deploy/nginx-obstresla.conf /etc/nginx/sites-available/obstresla
sudo ln -s /etc/nginx/sites-available/obstresla /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d obstresla.pro

# 4. Firewall + backups
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
sudo cp deploy/backup-db.sh /usr/local/bin/obstresla-backup && sudo chmod +x /usr/local/bin/obstresla-backup
echo '15 4 * * * root /usr/local/bin/obstresla-backup' | sudo tee /etc/cron.d/obstresla-backup
```

Requisitos externos: registro DNS `A` de `obstresla.pro` → IP del VPS,
y añadir `https://obstresla.pro` a los orígenes autorizados del OAuth
client en Google Cloud.

Actualizar: `cd /opt/obstresla && sudo -u obstresla git pull && sudo -u obstresla npm ci && sudo -u obstresla npm run build && sudo systemctl restart obstresla`

## Estructura

```
server/
  index.ts     # API REST + WebSockets + auth
  db.ts        # pool de PostgreSQL + esquema + datos de ejemplo
scripts/
  migrate-sqlite-to-pg.ts  # migración única desde la versión SQLite
client/src/
  App.tsx      # shell, login, enrutado, sidebar
  api.ts       # cliente HTTP + WebSocket con reconexión
  markdown.ts  # render markdown + wiki-links
  views/       # BoardView, CardModal, NotesView, ChatView, GraphView, SearchPalette
```
