#!/usr/bin/env bash
# Despliega cambios en el servidor. Ejecutar desde la raíz del proyecto: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

git pull --ff-only

# Backend + base de datos
docker compose up -d --build

# Cliente
(cd client && npm ci --include=dev && npm run build)
sudo mkdir -p /var/www/pagos
sudo rsync -a --delete client/dist/ /var/www/pagos/dist/

echo "Despliegue completo"
