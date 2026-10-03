#!/bin/bash
# Creates the replication role and one physical slot per replica.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v user="$POSTGRES_USER" -v pass="$POSTGRES_PASSWORD" <<'SQL'
-- Postgres 13 stores passwords as md5 unless this is set. Host auth is scram.
SET password_encryption = 'scram-sha-256';
ALTER ROLE :"user" PASSWORD :'pass';
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
SELECT pg_create_physical_replication_slot('replica_a');
SELECT pg_create_physical_replication_slot('replica_b');
SQL

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
