HAM MAP SERVER — VERSION 0.3.1

This package upgrades the existing static Ham Map installation with:

- One private single-operator account
- PostgreSQL-backed synchronized QSO log
- POTA and SOTA activation fields
- Manual QSO logging from phone, tablet or computer
- ADIF export at /api/qsos/adif after login
- WSJT-X/JTDX ingestion endpoint
- Server-side Pushover test delivery
- Automatic startup through systemd
- Automatic daily PostgreSQL backups
- Apache reverse proxy on /api

AUTOMATIC DEBIAN 13 INSTALLATION

1. Copy the release archive to the Debian server and extract it.
2. From inside ham-map-backend-package, run one installer:

   chmod +x install-debian.sh
   sudo ./install-debian.sh

The installer handles required Debian packages, the hammap-deploy account,
Node.js 24 LTS with checksum verification, PostgreSQL, Apache, systemd,
Fail2ban, firewall rules, backups, database setup, deployment, and health checks.
It is safe to rerun the same command to upgrade Ham Map.

3. Optional manual verification:

   systemctl is-active hammap
   curl http://127.0.0.1:3100/api/health
   curl http://192.168.1.69/api/health

4. Open http://192.168.1.69 and select Account. On first use, create the
   operator callsign and a password containing at least 12 characters.

The generated database password and WSJT-X ingestion token are stored in
/etc/hammap/hammap.env, readable only by root and the web-service group.
Do not paste that file into chat or commit it to source control.
