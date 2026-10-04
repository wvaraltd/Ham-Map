#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="/srv/hammap/releases/${RELEASE_ID}"
FIRST_INSTALL=1
if [[ -f /etc/hammap/hammap.env ]]; then
  FIRST_INSTALL=0
  set -a
  source /etc/hammap/hammap.env
  set +a
else
  DB_PASSWORD="$(openssl rand -base64 36 | tr -d '\n' | tr '/+' '_-')"
  WSJTX_INGEST_TOKEN="$(openssl rand -hex 32)"
  SECRETS_KEY="$(openssl rand -hex 32)"
  DATABASE_URL="postgresql://hammap:${DB_PASSWORD}@127.0.0.1:5432/hammap"
fi

command -v node >/dev/null
command -v npm >/dev/null
command -v psql >/dev/null
command -v apache2ctl >/dev/null

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -ne 24 ]]; then
  echo "Node.js 24 LTS is required; found $(node --version)." >&2
  exit 1
fi

install -d -o hammap-deploy -g www-data -m 2775 "$RELEASE_DIR" /srv/hammap/shared /srv/hammap/backups /var/www/hammap
chown postgres:hammap-deploy /srv/hammap/backups
chmod 2750 /srv/hammap/backups
install -d -o root -g www-data -m 0750 /etc/hammap
install -d -o hammap-deploy -g www-data -m 0750 /var/log/hammap
cp -a "$PACKAGE_DIR/app/." "$RELEASE_DIR/"
chown -R hammap-deploy:www-data "$RELEASE_DIR"

sudo -u hammap-deploy /usr/local/bin/npm --prefix "$RELEASE_DIR" install --omit=dev --no-audit --no-fund

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='hammap'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE hammap LOGIN PASSWORD '${DB_PASSWORD}'"
elif [[ "$FIRST_INSTALL" -eq 1 ]]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE hammap PASSWORD '${DB_PASSWORD}'"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='hammap'" | grep -q 1; then
  sudo -u postgres createdb -O hammap hammap
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -d hammap -f "$RELEASE_DIR/schema.sql"
for TABLE_NAME in operators sessions settings qsos notification_settings; do
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d hammap -c "ALTER TABLE ${TABLE_NAME} OWNER TO hammap"
done
for SEQUENCE_NAME in operators_id_seq qsos_id_seq; do
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d hammap -c "ALTER SEQUENCE ${SEQUENCE_NAME} OWNER TO hammap"
done

if [[ "$FIRST_INSTALL" -eq 1 ]]; then
cat > /etc/hammap/hammap.env <<EOF
HOST=127.0.0.1
PORT=3100
DATABASE_URL=${DATABASE_URL}
WSJTX_INGEST_TOKEN=${WSJTX_INGEST_TOKEN}
SECRETS_KEY=${SECRETS_KEY}
NODE_ENV=production
EOF
chown root:www-data /etc/hammap/hammap.env
chmod 0640 /etc/hammap/hammap.env
fi

ln -sfn "$RELEASE_DIR" /srv/hammap/current
cp "$PACKAGE_DIR/deploy/hammap.service" /etc/systemd/system/hammap.service
install -o root -g root -m 0755 "$PACKAGE_DIR/deploy/hammap-backup" /usr/local/sbin/hammap-backup
cp "$PACKAGE_DIR/deploy/hammap-backup.service" /etc/systemd/system/hammap-backup.service
cp "$PACKAGE_DIR/deploy/hammap-backup.timer" /etc/systemd/system/hammap-backup.timer
cp "$PACKAGE_DIR/deploy/apache-hammap.conf" /etc/apache2/sites-available/hammap.conf
rsync -a --delete "$PACKAGE_DIR/app/public/" /var/www/hammap/
chown -R hammap-deploy:www-data /var/www/hammap

a2enmod proxy proxy_http headers rewrite ssl >/dev/null
a2dissite 000-default.conf >/dev/null 2>&1 || true
a2ensite hammap.conf >/dev/null
apache2ctl configtest
systemctl daemon-reload
systemctl enable hammap >/dev/null
systemctl restart hammap
systemctl enable --now hammap-backup.timer
systemctl reload apache2

echo
echo "Ham Map backend installed."
echo "Local URL: http://192.168.1.69"
echo "Health check: http://192.168.1.69/api/health"
echo "WSJT-X ingestion token is stored in /etc/hammap/hammap.env"
echo "Complete first-run operator setup from the Account button in Ham Map."
