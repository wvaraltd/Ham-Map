HAM MAP SERVER BACKEND — VERSION 0.1

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

INSTALLATION

1. Upload ham-map-backend-v0.1.zip to /home/hammap-deploy.
2. Run:

   cd /home/hammap-deploy
   unzip ham-map-backend-v0.1.zip -d ham-map-backend-v0.1
   cd ham-map-backend-v0.1/ham-map-backend-package
   chmod +x deploy/install.sh
   sudo ./deploy/install.sh

3. Verify:

   systemctl is-active hammap
   curl http://127.0.0.1:3100/api/health
   curl http://192.168.1.69/api/health

4. Open http://192.168.1.69 and select Account. On first use, create the
   operator callsign and a password containing at least 12 characters.

The generated database password and WSJT-X ingestion token are stored in
/etc/hammap/hammap.env, readable only by root and the web-service group.
Do not paste that file into chat or commit it to source control.
