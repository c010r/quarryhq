#!/usr/bin/env bash
# Backup diario de la base de Obstresla. Conserva los últimos 14 días.
# Instalar:  sudo cp deploy/backup-db.sh /usr/local/bin/obstresla-backup && sudo chmod +x /usr/local/bin/obstresla-backup
# Cron:      echo '15 4 * * * root /usr/local/bin/obstresla-backup' | sudo tee /etc/cron.d/obstresla-backup
set -euo pipefail

DEST=/var/backups/obstresla
mkdir -p "$DEST"

sudo -u postgres pg_dump obstresla | gzip > "$DEST/obstresla-$(date +%F).sql.gz"

# Borra backups de más de 14 días
find "$DEST" -name 'obstresla-*.sql.gz' -mtime +14 -delete

# Recomendado: copiar el más reciente fuera del VPS (rclone, scp, S3…)
