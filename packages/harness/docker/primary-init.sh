#!/bin/bash
# Creates the replication role and one physical slot per replica.
# The password is stored with the server default, scram-sha-256 since Postgres 14.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
SELECT pg_create_physical_replication_slot('replica_a');
SELECT pg_create_physical_replication_slot('replica_b');
SQL

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
