#!/usr/bin/env bash
# Deploy AG Studio trên node trung tâm: build image, thay api (tự migrate studio.db khi khởi động),
# rồi worker (chỉ sau khi api healthy), rồi web. Cần ../ag-farm (AG_FARM_DIR) đã checkout.
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ ! -f .env ]]; then
  echo "Thiếu .env (sao chép .env.example rồi điền)." >&2
  exit 1
fi
farm_dir=$(grep -E '^AG_FARM_DIR=' .env | cut -d= -f2- || true)
if [[ ! -f "${farm_dir:-../ag-farm}/package.json" ]]; then
  echo "Không thấy checkout ag-farm ở ${farm_dir:-../ag-farm} (AG_FARM_DIR)." >&2
  exit 1
fi

log 'Build image'
docker compose build api web

log 'Thay api (migrate studio.db) và chờ healthy'
docker compose up -d --no-deps --wait api

log 'Thay worker (chạy xong stage đang dở trước khi dừng bản cũ)'
docker compose up -d --no-deps worker

log 'Thay web'
docker compose up -d --no-deps web

log 'Xong'
docker compose ps
