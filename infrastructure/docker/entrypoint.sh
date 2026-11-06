#!/bin/bash
set -euo pipefail

PG_BIN=/usr/lib/postgresql/17/bin
export PGDATA=/data/pg
mkdir -p "$PGDATA"
chown -R postgres:postgres /data
chmod 700 "$PGDATA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  su postgres -c "$PG_BIN/initdb -D $PGDATA --locale=C --encoding=UTF8 --auth-local=peer --auth-host=scram-sha-256"
  printf "\nlisten_addresses = '127.0.0.1'\n" >> "$PGDATA/postgresql.conf"
fi
su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -w -l $PGDATA/postgres.log start"
python /opt/factorix/infrastructure/docker/bootstrap_db.py
cd /opt/factorix/apps/center
alembic upgrade head

# Supervise the edge collector: restart it whenever it exits (backoff 1 s .. 30 s,
# reset after a run of at least 60 s) so the appliance is never left without an edge.
supervise_edge() {
  set +e
  local child=0
  local backoff=1
  trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
  while true; do
    local started=$SECONDS
    python -m factorix_edge &
    child=$!
    wait "$child"
    local code=$?
    if [ $((SECONDS - started)) -ge 60 ]; then
      backoff=1
    fi
    echo "factorix-edge exited with code $code; restarting in ${backoff}s" >&2
    sleep "$backoff" &
    wait $!
    if [ "$backoff" -lt 30 ]; then
      backoff=$((backoff * 2))
    fi
  done
}

supervise_edge &
EDGE_PID=$!
python -m uvicorn factorix.transport.app:app --host 0.0.0.0 --port 8080 &
APP_PID=$!

stop() {
  kill "$APP_PID" "$EDGE_PID" 2>/dev/null || true
  su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -m fast -w stop" || true
}
trap stop TERM INT
wait "$APP_PID"
stop
