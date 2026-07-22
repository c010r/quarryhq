#!/usr/bin/env bash
# Backup diario de la base de QuarryHQ, con copia off-site opcional.
#
# Conserva los últimos 14 días en /var/backups/quarryhq (severidad media) y,
# si hay credenciales S3/R2 configuradas, sube cada backup a un bucket con
# retención independiente. Con esto sobrevives a: borrado accidental, fallo de
# disco del VPS y ransomware que cifre /var (lo off-site queda intacto).
#
# Instalar:  sudo cp deploy/backup-db.sh /usr/local/bin/quarryhq-backup && sudo chmod +x /usr/local/bin/quarryhq-backup
# Cron:      echo '15 4 * * * root /usr/local/bin/quarryhq-backup' | sudo tee /etc/cron.d/quarryhq-backup
#
# Variables de entorno (definirlas en /etc/quarryhq/backup.env o el .env del
# servicio y sourcearlas, p. ej. EnvironmentFile en systemd):
#   BACKUP_S3_ENDPOINT       https://s3.amazonaws.com | https://<account>.r2.cloudflarestorage.com
#   BACKUP_S3_BUCKET         quarryhq-backups
#   BACKUP_S3_PREFIX         db/                    (carpeta dentro del bucket)
#   BACKUP_S3_ACCESS_KEY     AKIA...
#   BACKUP_S3_SECRET_KEY     ...
#   BACKUP_S3_REGION         us-east-1              (_BUCKET_VIRTUAL_HOST: déjalo en blanco para R2)
#   BACKUP_RETENTION_DAYS   30                     (objetos viejos en el bucket)
#   BACKUP_ENCRYPTION_PASS   (opcional) encripta el dump con AES-256-CBC; es
#                            el momento barato de cifrar backups en reposo.
#   BACKUP_ENCRYPTION_SALT   (recomendado si usás encriptación, para derivar)
# Cualquiera que falte deshabilita el upload off-site (pero deja el dump local).
set -euo pipefail

DEST=/var/backups/quarryhq
STAMP="$(date +%F)"
FILE="$DEST/quarryhq-$STAMP.sql.gz"
mkdir -p "$DEST"

# 1) Dump local (respaldo inmediato, lado resorte si el VPS sigue vivo).
sudo -u postgres pg_dump quarryhq | gzip > "$FILE"

# 2) Cifrado opcional (en sitio BEFORE upload, así el bucket nunca ve el dump en
# claro ni siquiera si el bucket es de acceso público por misconfiguration).
UPLOAD_FILE="$FILE"
UPLOAD_SUFFIX="sql.gz"
if [ -n "${BACKUP_ENCRYPTION_PASS:-}" ]; then
  UPLOAD_SUFFIX="sql.gz.enc"
  UPLOAD_FILE="$DEST/quarryhq-$STAMP.$UPLOAD_SUFFIX"
  # Salt fijo (env) si lo proveés, sino se deriva al azar por backup (más
  # seguro, pero el salt se guarda en el header del archivo — formato
  # openssl Salted__). Para restaurar: openssl aes-256-cbc -d -pass pass:...
  SALT_ARGS=()
  if [ -n "${BACKUP_ENCRYPTION_SALT:-}" ]; then SALT_ARGS=(-S "$BACKUP_ENCRYPTION_SALT"); fi
  openssl enc -aes-256-cbc "${SALT_ARGS[@]}" -salt -pbkdf2 -pass env:BACKUP_ENCRYPTION_PASS \
    -in "$FILE" -out "$UPLOAD_FILE"
fi

# 3) Limpieza disco local: 14 días.
find "$DEST" -name 'quarryhq-*.sql.gz*' -mtime +14 -delete

# 4) Upload off-site a S3/R2 con aws-cli (compatible con cualquier endpoint S3).
#   Si tenés `mc` (MinIO) en vez de aws-cli, reemplazar por:
#   mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" --api S3v4
#   mc cp "$UPLOAD_FILE" "backup/$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX"
if [ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  KEY="${BACKUP_S3_PREFIX:-db/}quarryhq-$STAMP.$UPLOAD_SUFFIX"
  AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}" \
  AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}" \
  AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
  aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp "$UPLOAD_FILE" "s3://${BACKUP_S3_BUCKET}/$KEY" \
    --metadata "Date=$STAMP"
  # 5) Retención off-site: borra objetos >N días del bucket (anti-acumulación).
  if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
    CUT=$(date -d "${BACKUP_RETENTION_DAYS} days ago" +%Y-%m-%d -u 2>/dev/null || date -v-${BACKUP_RETENTION_DAYS}d +%Y-%m-%d -u)
    aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3api list-objects-v2 \
      --bucket "$BACKUP_S3_BUCKET" --prefix "${BACKUP_S3_PREFIX:-db/}" \
      | jq -r '.Contents[]? | select(.LastModified < "'"$CUT"'T00:00:00Z") | .Key' \
      | xargs -r -I{} aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 rm "s3://${BACKUP_S3_BUCKET}/{}"
  fi
fi

# 6) Sin aws-cli -> reducción graceful: el dump local queda accesible para
# que un script externo (rclone, restic, rsync.net) se lo lleve.  El cron/deploy
# puede encadenar `quarryhq-backup && rclone copy /var/backups/quarryhq rclone:quarryhq-backups`.
exit 0