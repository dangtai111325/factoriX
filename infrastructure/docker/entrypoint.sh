#!/bin/bash
set -euo pipefail

DB_URL="${FACTORIX_DATABASE_URL:-}"
USE_EXTERNAL_PG=false

if [ -n "$DB_URL" ] && ! echo "$DB_URL" | grep -q "127.0.0.1"; then
  USE_EXTERNAL_PG=true
fi

if [ "$USE_EXTERNAL_PG" = true ]; then
  echo "Configured for external PostgreSQL: $DB_URL"
  until python -c "
import asyncio, os, sys, asyncpg
dsn = os.environ.get('FACTORIX_DATABASE_URL', '')
if dsn.startswith('postgresql+asyncpg://'):
    dsn = 'postgresql://' + dsn[len('postgresql+asyncpg://'):]
async def test():
    try:
        conn = await asyncpg.connect(dsn, timeout=3)
        await conn.close()
        sys.exit(0)
    except Exception:
        sys.exit(1)
asyncio.run(test())
" 2>/dev/null; do
    echo "Waiting for external PostgreSQL to accept connections..."
    sleep 1
  done
  echo "External PostgreSQL is ready!"
else
  PG_BIN=/usr/lib/postgresql/17/bin
  export PGDATA=/data/pg
  mkdir -p "$PGDATA"
  chown -R postgres:postgres /data
  chmod 700 "$PGDATA"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    su postgres -c "$PG_BIN/initdb -D $PGDATA --locale=C --encoding=UTF8 --auth-local=peer --auth-host=scram-sha-256"
    printf "\nlisten_addresses = '127.0.0.1'\n" >> "$PGDATA/postgresql.conf"
  fi
  if ! grep -q "synchronous_commit = off" "$PGDATA/postgresql.conf"; then
    cat <<'EOF' >> "$PGDATA/postgresql.conf"

# Performance tuning for high-throughput IIoT ingestion
shared_buffers = 1024MB
work_mem = 32MB
maintenance_work_mem = 256MB
wal_buffers = 16MB
max_wal_size = 4GB
checkpoint_completion_target = 0.9
synchronous_commit = off
EOF
  fi
  su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -w -l $PGDATA/postgres.log start"
  python /opt/factorix/infrastructure/docker/bootstrap_db.py
fi

cd /opt/factorix/apps/center
alembic upgrade head

supervise_process() {
  local module_name="$1"
  set +e
  local child=0
  local backoff=1
  trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
  while true; do
    local started=$SECONDS
    python -m "$module_name" &
    child=$!
    wait "$child"
    local code=$?
    if [ $((SECONDS - started)) -ge 60 ]; then
      backoff=1
    fi
    echo "$module_name exited with code $code; restarting in ${backoff}s" >&2
    sleep "$backoff" &
    wait $!
    if [ "$backoff" -lt 30 ]; then
      backoff=$((backoff * 2))
    fi
  done
}

# Supervise strictly one acquisition path (never edge + acquisition simultaneously to prevent double polling).
WORKERS=()
MODE="${FACTORIX_COLLECTOR_MODE:-edge}"
if [ "$MODE" = "acquisition" ]; then
  if [ -z "${FACTORIX_RABBITMQ_URL:-}" ] || [ -z "${FACTORIX_TDENGINE_DSN:-}" ]; then
    echo "FACTORIX_COLLECTOR_MODE=acquisition requires FACTORIX_RABBITMQ_URL and FACTORIX_TDENGINE_DSN; refusing unsafe startup." >&2
    exit 1
  fi
  mkdir -p "${FACTORIX_ACQUISITION_DIR:-/data/acquisition}" "${FACTORIX_STORAGE_EXPORT_DIR:-/data/exports}"
  supervise_process "factorix_acquisition" &
  WORKERS+=($!)
  supervise_process "factorix.ingestion" &
  WORKERS+=($!)
else
  supervise_process "factorix_edge" &
  WORKERS+=($!)
fi

python -m uvicorn factorix.transport.app:app --host 0.0.0.0 --port 8080 &
APP_PID=$!

stop() {
  kill "$APP_PID" "${WORKERS[@]}" 2>/dev/null || true
  wait "$APP_PID" "${WORKERS[@]}" 2>/dev/null || true
  if [ "$USE_EXTERNAL_PG" = false ]; then
    su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -m fast -w stop" || true
  fi
}
trap stop TERM INT
wait "$APP_PID"
stop
