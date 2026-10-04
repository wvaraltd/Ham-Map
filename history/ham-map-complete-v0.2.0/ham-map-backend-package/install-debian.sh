#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root: sudo ./install-debian.sh" >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then echo "Cannot identify this Linux system." >&2; exit 1; fi
source /etc/os-release
if [[ ${ID:-} != debian || ${VERSION_ID%%.*} -lt 13 ]]; then
  echo "Ham Map requires Debian 13 or newer; found ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION="${HAMMAP_NODE_VERSION:-24.21.0}"
export DEBIAN_FRONTEND=noninteractive

echo "[1/8] Installing Debian packages"
apt-get update
apt-get install -y --no-install-recommends apache2 postgresql postgresql-client ca-certificates curl xz-utils openssl rsync sudo ufw fail2ban

echo "[2/8] Creating the deployment account"
if ! id hammap-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash hammap-deploy
fi
usermod -aG www-data hammap-deploy

echo "[3/8] Installing Node.js 24 LTS"
CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ "$CURRENT_MAJOR" != 24 ]]; then
  case "$(dpkg --print-architecture)" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "Unsupported CPU architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  NODE_FILE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  NODE_TMP="$(mktemp -d)"
  trap 'rm -rf -- "$NODE_TMP"' EXIT
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_FILE}" --output "$NODE_TMP/$NODE_FILE"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" --output "$NODE_TMP/SHASUMS256.txt"
  (cd "$NODE_TMP" && grep " ${NODE_FILE}$" SHASUMS256.txt | sha256sum --check --strict)
  tar -xJf "$NODE_TMP/$NODE_FILE" -C /opt
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" /usr/local/bin/node
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/npm" /usr/local/bin/npm
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/npx" /usr/local/bin/npx
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/corepack" /usr/local/bin/corepack
else
  for NODE_COMMAND in node npm npx corepack; do
    NODE_PATH="$(command -v "$NODE_COMMAND" 2>/dev/null || true)"
    if [[ -n "$NODE_PATH" && "$NODE_PATH" != "/usr/local/bin/$NODE_COMMAND" ]]; then
      ln -sfn "$NODE_PATH" "/usr/local/bin/$NODE_COMMAND"
    fi
  done
fi
/usr/local/bin/node --version

echo "[4/8] Checking the HTTP port"
HTTP_OWNER="$(ss -H -lntp 'sport = :80' 2>/dev/null || true)"
if [[ -n "$HTTP_OWNER" && "$HTTP_OWNER" != *apache2* ]]; then
  echo "Port 80 is already used by another service. Stop it, then rerun this installer:" >&2
  echo "$HTTP_OWNER" >&2
  exit 1
fi

echo "[5/8] Starting database and web services"
systemctl enable --now postgresql apache2 fail2ban

echo "[6/8] Configuring the firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Apache Full' >/dev/null
ufw --force enable >/dev/null

echo "[7/8] Installing or upgrading Ham Map"
chmod +x "$PACKAGE_DIR/deploy/install.sh" "$PACKAGE_DIR/deploy/hammap-backup"
"$PACKAGE_DIR/deploy/install.sh"

echo "[8/8] Running health checks"
systemctl is-active --quiet hammap
systemctl is-active --quiet apache2
systemctl is-active --quiet postgresql
curl --fail --silent --show-error --retry 8 --retry-delay 1 http://127.0.0.1:3100/api/health >/dev/null
curl --fail --silent --show-error --retry 3 --retry-delay 1 http://127.0.0.1/api/health >/dev/null

SERVER_IP="$(hostname -I | awk '{print $1}')"
echo
echo "Ham Map is fully operational."
echo "Open: http://${SERVER_IP:-127.0.0.1}"
echo "Then select Account to create or sign into the operator account."
echo "Re-running this same installer safely installs future upgrades."
