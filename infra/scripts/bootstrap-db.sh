#!/usr/bin/env bash
#
# Creates the local development PostgreSQL role and databases.
# Idempotent: safe to run any number of times.
#
# Local dev values only (contract §4). This script never touches a remote host.
# Requires passwordless `sudo -u postgres psql` on this machine.

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_ROLE="${DB_ROLE:-intelligenz}"
DB_PASSWORD="${DB_PASSWORD:-intelligenz}"
DB_NAME="${DB_NAME:-intelligenz_dev}"
DB_TEST_NAME="${DB_TEST_NAME:-intelligenz_test}"
# `prisma migrate dev` needs a scratch database it may drop and recreate. The
# application role deliberately has no CREATEDB privilege, so the shadow database
# is provisioned here and referenced by SHADOW_DATABASE_URL. `migrate deploy`
# (bootstrap and CI) never touches it.
DB_SHADOW_NAME="${DB_SHADOW_NAME:-intelligenz_shadow}"

log() { printf '[db] %s\n' "$*"; }
fail() {
  printf '[db] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH. Install the PostgreSQL client."
command -v sudo >/dev/null 2>&1 || fail "sudo not found. This script needs 'sudo -u postgres psql'."

command -v pg_isready >/dev/null 2>&1 &&
  pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1 ||
  fail "PostgreSQL is not accepting connections on ${DB_HOST}:${DB_PORT}."

as_superuser() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
}

log "creating role '${DB_ROLE}' (if absent) and resetting its password"
as_superuser -q \
  -v role="$DB_ROLE" \
  -v password="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
-- Keep the password deterministic on repeat runs so a stale .env never mismatches.
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'role', :'password')
\gexec
SQL

create_database() {
  local dbname="$1"
  log "creating database '${dbname}' (if absent), owner '${DB_ROLE}'"
  as_superuser -q \
    -v dbname="$dbname" \
    -v role="$DB_ROLE" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'dbname', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'dbname', :'role')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'dbname', :'role')
\gexec
SQL

  # Schema-level ownership: on PostgreSQL 15+ `public` is owned by
  # pg_database_owner, so the database owner alone is not sufficient for
  # Prisma to create tables.
  as_superuser -q -d "$dbname" -v role="$DB_ROLE" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'role')
\gexec
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'role')
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', :'role')
\gexec
SQL
}

create_database "$DB_NAME"
# Separate database so integration tests cannot truncate development data
# (baseline §7.1: no Docker means no disposable container per test run).
create_database "$DB_TEST_NAME"
create_database "$DB_SHADOW_NAME"

# Prisma migrations are applied only once the database package owns a schema.
# Until then this stage reports that it has nothing to do instead of failing.
MIGRATIONS_DIR="packages/database/prisma/migrations"
if [[ -d "$MIGRATIONS_DIR" ]]; then
  log "applying Prisma migrations from ${MIGRATIONS_DIR}"
  pnpm --filter @intelligenz/database exec prisma migrate deploy
else
  log "no Prisma migrations yet (${MIGRATIONS_DIR} absent) — skipped"
fi

log "verifying the application role can connect"
psql "postgresql://${DB_ROLE}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}" \
  -v ON_ERROR_STOP=1 \
  -c "select current_database(), current_user;"

log "done"
