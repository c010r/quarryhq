#!/usr/bin/env bash
# Backup diario de la base de QuarryHQ. Conserva los últimos 14 días.
# Instalar:  sudo cp deploy/backup-db.sh /usr/local/bin/quarryhq-backup && sudo chmod +x /usr/local/bin/quarryhq-backup
# Cron:      echo '15 4 * * * root /usr/local/bin/quarryhq-backup' | sudo tee /etc/cron.d/quarryhq-backup
set -euo pipefail

DEST=/var/backups/quarryhq
mkdir -p "$DEST"

sudo -u postgres pg_dump quarryhq | gzip > "$DEST/quarryhq-$(date +%F).sql.gz"

# Borra backups de más de 14 días
find "$DEST" -name 'quarryhq-*.sql.gz' -mtime +14 -delete

# Recomendado: copiar el más reciente fuera del VPS (rclone, scp, S3…)
