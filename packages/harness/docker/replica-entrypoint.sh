#!/bin/bash
# Clones the primary with pg_basebackup and starts a hot standby on its slot.
set -euo pipefail

: "${PRIMARY_HOST:?PRIMARY_HOST is required}"
: "${SLOT_NAME:?SLOT_NAME is required}"
: "${REPLICATOR_PASSWORD:?REPLICATOR_PASSWORD is required}"
: "${PGDATA:?PGDATA is required}"

# The image entrypoint is replaced, so this process starts as root.
# Postgres refuses to run as root, and the data directory must be owned by postgres.
if [[ "$(id -u)" -eq 0 ]]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  exec gosu postgres "$0"
fi

if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  mkdir -p "$PGDATA"
  echo "waiting for ${PRIMARY_HOST} before cloning ${SLOT_NAME}" >&2
  ready=0
  for _ in $(seq 1 60); do
    if pg_isready -h "$PRIMARY_HOST" -p 5432 -U replicator >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "primary ${PRIMARY_HOST} did not become ready" >&2
    exit 1
  fi

  cloned=0
  for _ in $(seq 1 30); do
    find "$PGDATA" -mindepth 1 -delete
    if PGPASSWORD="$REPLICATOR_PASSWORD" pg_basebackup \
      -h "$PRIMARY_HOST" \
      -p 5432 \
      -U replicator \
      -D "$PGDATA" \
      -Fp -Xs \
      -S "$SLOT_NAME"; then
      cloned=1
      break
    fi
    sleep 2
  done
  if [[ "$cloned" -ne 1 ]]; then
    echo "pg_basebackup failed for ${SLOT_NAME}" >&2
    exit 1
  fi

  touch "$PGDATA/standby.signal"
  cat >> "$PGDATA/postgresql.auto.conf" <<EOF
primary_conninfo = 'host=${PRIMARY_HOST} port=5432 user=replicator password=${REPLICATOR_PASSWORD} application_name=${SLOT_NAME}'
primary_slot_name = '${SLOT_NAME}'
hot_standby = on
EOF
  chmod 0700 "$PGDATA"
fi

exec postgres -c listen_addresses='*' -c hot_standby=on
