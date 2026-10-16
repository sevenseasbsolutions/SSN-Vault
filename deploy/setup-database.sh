#!/usr/bin/env bash
# Create the PostgreSQL role and databases for Vault, and write .env / .env.test.
#
#   sudo deploy/setup-database.sh
#
# Safe to run again: an existing role, database or .env is kept. The role's
# password is (re)set to the one in .env, so the two can never drift apart.
#
#   ssn_vault        the application's database
#   ssn_vault_test   throwaway database for `npm test` (each test file makes and
#                    drops its own schema in it); never holds real data
#
# Both are created with the C.UTF-8 locale: text sorts and compares by code
# point, exactly as the SQLite build of this application did, so lists, ids
# in paths and ISO dates order the same way they always have.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${APP_USER:-$(stat -c %U "$APP_DIR")}"
DB_NAME="${DB_NAME:-ssn_vault}"
DB_USER="${DB_USER:-ssn_vault}"
TEST_DB_NAME="${DB_NAME}_test"
ENV_FILE="$APP_DIR/.env"
TEST_ENV_FILE="$APP_DIR/.env.test"

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo $0" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql not found: install postgresql first" >&2; exit 1; }
systemctl is-active --quiet postgresql || { echo "postgresql is not running" >&2; exit 1; }

as_postgres() { sudo -u postgres psql -v ON_ERROR_STOP=1 -X -q "$@"; }

# --- .env: create from the template once, then reuse its password ---------
if [[ ! -f "$ENV_FILE" ]]; then
  install -o "$APP_USER" -g "$APP_USER" -m 600 "$APP_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example"
fi
chmod 600 "$ENV_FILE"; chown "$APP_USER:$APP_USER" "$ENV_FILE"

DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
if [[ -z "$DB_PASSWORD" || "$DB_PASSWORD" == "change-me" ]]; then
  # Hex only: safe unquoted in .env and inside a connection URL.
  DB_PASSWORD="$(openssl rand -hex 24)"
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" "$ENV_FILE"
  echo "Generated a database password and saved it to $ENV_FILE"
fi
sed -i "s|^DB_NAME=.*|DB_NAME=${DB_NAME}|; s|^DB_USER=.*|DB_USER=${DB_USER}|" "$ENV_FILE"

# --- role ---------------------------------------------------------------------
as_postgres -v role="$DB_USER" -v pw="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
ALTER ROLE :"role" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
SQL
echo "Role $DB_USER ready"

# --- databases ----------------------------------------------------------------
for db in "$DB_NAME" "$TEST_DB_NAME"; do
  as_postgres -v db="$db" -v role="$DB_USER" <<'SQL'
SELECT format(
  'CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L LOCALE_PROVIDER libc LOCALE %L',
  :'db', :'role', 'UTF8', 'C.UTF-8')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
-- Only the application's role may connect.
REVOKE CONNECT, TEMPORARY ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO :"role";
SQL
  echo "Database $db ready"
done

# --- .env.test: where `npm test` puts its throwaway schemas -------------------
umask 077
printf '# Written by deploy/setup-database.sh. Used only by `npm test`.\nTEST_DATABASE_URL=postgres://%s:%s@127.0.0.1:5432/%s\n' \
  "$DB_USER" "$DB_PASSWORD" "$TEST_DB_NAME" > "$TEST_ENV_FILE"
chown "$APP_USER:$APP_USER" "$TEST_ENV_FILE"; chmod 600 "$TEST_ENV_FILE"
echo "Wrote $TEST_ENV_FILE"

# --- prove the application can actually log in --------------------------------
PGPASSWORD="$DB_PASSWORD" psql -X -q -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" \
  -c 'SELECT 1' >/dev/null && echo "Login as $DB_USER over 127.0.0.1 works"
