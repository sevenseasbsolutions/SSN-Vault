#!/usr/bin/env bash
# Install SSN Vault on this server: database, both services, nginx, https.
#
#   sudo NODE_BIN="$(command -v node)" OWNER_EMAIL=you@example.com deploy/install.sh
#
# NODE_BIN     the node binary the services run (sudo drops nvm from PATH, so
#              pass it; otherwise the newest ~/.nvm node of the repo's owner)
# OWNER_EMAIL  sign-in email for the first owner account (first install only)
# CERTBOT_EMAIL  only needed if certbot has no account on this machine yet
#
# Safe to run again after a `git pull`: it reinstalls dependencies, restarts
# both services, and keeps the existing database, .env and certificate.
#
# Stages, in order -- each one is checked before the next starts:
#   1. PostgreSQL role + databases, .env       (deploy/setup-database.sh)
#   2. npm ci                                  as the app user
#   3. ssn-vault-api + ssn-vault-web           systemd, then health-checked
#   4. nginx, http only                        answers the ACME challenge
#   5. DNS check, then certbot                 Let's Encrypt, webroot
#   6. nginx, https                            and a final end-to-end check
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(stat -c %U "$APP_DIR")"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
DEPLOY="$APP_DIR/deploy"
SITE=/etc/nginx/sites-available/ssn-vault
WEBROOT=/var/www/letsencrypt

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run as root: sudo NODE_BIN=\"\$(command -v node)\" $0"

# --- node ---------------------------------------------------------------------
if [[ -z "${NODE_BIN:-}" ]]; then
  NODE_BIN="$(ls -1d "$APP_HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
fi
[[ -x "${NODE_BIN:-}" ]] || fail "node not found. Pass it: sudo NODE_BIN=\"\$(command -v node)\" $0"
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=9)?0:1)' \
  || fail "node $NODE_VERSION is too old; 22.9 or newer is required"
NODE_DIR="$(dirname "$NODE_BIN")"
echo "Using node $NODE_VERSION at $NODE_BIN, running as $APP_USER"

as_app() { sudo -u "$APP_USER" env HOME="$APP_HOME" PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" "$@"; }
render() { sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@APP_USER@|$APP_USER|g" -e "s|@NODE_BIN@|$NODE_BIN|g" \
               -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@API_PORT@|$API_PORT|g" -e "s|@WEB_PORT@|$WEB_PORT|g" "$1"; }

# --- 1. database and .env -----------------------------------------------------
say "1/6  PostgreSQL"
bash "$DEPLOY/setup-database.sh"

ENV_FILE="$APP_DIR/.env"
if [[ -n "${OWNER_EMAIL:-}" ]]; then
  sed -i "s|^OWNER_EMAIL=.*|OWNER_EMAIL=${OWNER_EMAIL}|" "$ENV_FILE"
fi
env_get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
DOMAIN="$(env_get DOMAIN)";  API_PORT="$(env_get PORT)";  WEB_PORT="$(env_get WEB_PORT)"
[[ -n "$DOMAIN" && -n "$API_PORT" && -n "$WEB_PORT" ]] || fail "DOMAIN, PORT and WEB_PORT must be set in $ENV_FILE"
[[ "$(env_get SERVE_FRONTEND)" == "false" ]] || fail "SERVE_FRONTEND must be false in $ENV_FILE: the frontend is its own service"
# A port may already be held by this app's own service (a re-run); by
# anything else, it is a conflict to stop on rather than fight over.
for port in "$API_PORT" "$WEB_PORT"; do
  pid="$(ss -ltnpH "( sport = :$port )" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  [[ -z "$pid" ]] && continue
  unit="$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [[ "$unit" == ssn-vault-api.service || "$unit" == ssn-vault-web.service ]] \
    || fail "port $port is already used by another program (pid $pid${unit:+, $unit}). Change PORT/WEB_PORT in $ENV_FILE."
done

# --- 2. dependencies ----------------------------------------------------------
say "2/6  Dependencies (npm ci)"
( cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund )

# --- 3. services --------------------------------------------------------------
say "3/6  systemd services"
for unit in ssn-vault-api ssn-vault-web; do
  render "$DEPLOY/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable ssn-vault-api ssn-vault-web >/dev/null
systemctl restart ssn-vault-api ssn-vault-web

wait_for() {  # url, what
  for _ in $(seq 1 30); do curl -fsS -o /dev/null "$1" && return 0; sleep 1; done
  return 1
}
wait_for "http://127.0.0.1:$API_PORT/api/health" \
  || { journalctl -u ssn-vault-api -n 40 --no-pager; fail "the API did not come up (log above)"; }
wait_for "http://127.0.0.1:$WEB_PORT/" \
  || { journalctl -u ssn-vault-web -n 40 --no-pager; fail "the frontend did not come up (log above)"; }
echo "API on 127.0.0.1:$API_PORT and frontend on 127.0.0.1:$WEB_PORT are healthy"

# --- nginx helper: install a site, test, roll back if nginx rejects it --------
install_site() {  # template
  local backup=""
  [[ -f "$SITE" ]] && backup="$(mktemp)" && cp "$SITE" "$backup"
  render "$DEPLOY/nginx-ssn-vault-app.conf" > /etc/nginx/snippets/ssn-vault-app.conf
  render "$1" > "$SITE"
  ln -sfn "$SITE" /etc/nginx/sites-enabled/ssn-vault
  if ! nginx -t 2>/tmp/ssn-vault-nginx-test.log; then
    cat /tmp/ssn-vault-nginx-test.log >&2
    if [[ -n "$backup" ]]; then cp "$backup" "$SITE"; else rm -f "$SITE" /etc/nginx/sites-enabled/ssn-vault; fi
    fail "nginx rejected the new config; the previous one was restored and nothing was reloaded"
  fi
  systemctl reload nginx
  [[ -n "$backup" ]] && rm -f "$backup"
  return 0
}

CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
mkdir -p "$WEBROOT"

# --- 4. + 5. certificate ------------------------------------------------------
if [[ -f "$CERT" ]]; then
  say "4/6  Certificate for $DOMAIN already exists (certbot renews it automatically)"
  say "5/6  Skipped"
else
  say "4/6  nginx, http only (for the ACME challenge)"
  install_site "$DEPLOY/nginx-ssn-vault-http.conf"

  say "5/6  DNS and certificate"
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
  RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
  if [[ -z "$RESOLVED" || ( -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ) ]]; then
    cat >&2 <<MSG

$DOMAIN does not point at this server yet.
  resolves to: ${RESOLVED:-nothing}
  this server: ${PUBLIC_IP:-unknown}

Add this record at your DNS provider, wait a few minutes, then run this script again:
  Type A   Name ${DOMAIN%%.*}   Value ${PUBLIC_IP:-<your public IP>}   TTL 300

The services are running; only https is waiting on DNS.
MSG
    exit 2
  fi
  echo "$DOMAIN resolves to $RESOLVED (this server)"

  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --keep-until-expiring \
    --deploy-hook "systemctl reload nginx" \
    ${CERTBOT_EMAIL:+-m "$CERTBOT_EMAIL"} \
    || fail "certbot could not issue a certificate (see above). Check that ports 80 and 443 on your router forward to this server."
fi

# --- 6. https -----------------------------------------------------------------
say "6/6  nginx, https"
install_site "$DEPLOY/nginx-ssn-vault-https.conf"

# Checked through nginx on this machine, so it does not depend on the router
# supporting hairpin NAT.
# `systemctl reload` returns before nginx's workers have switched over, so
# the new certificate may take a moment to be the one served: retry briefly.
HEALTH=""
for _ in $(seq 1 15); do
  HEALTH="$(curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null || true)"
  [[ "$HEALTH" == *'"ok":true'* ]] && break
  sleep 1
done
[[ "$HEALTH" == *'"ok":true'* ]] || fail "https://$DOMAIN/api/health did not answer through nginx: ${HEALTH:-no response}"
curl -fsS --max-time 10 -o /dev/null --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" \
  || fail "https://$DOMAIN/ did not serve the frontend through nginx"

say "Done: https://$DOMAIN"
# The one-time password is only worth showing while it is still the one in use.
MUST_CHANGE="$(PGPASSWORD="$(env_get DB_PASSWORD)" psql -X -qAt -h 127.0.0.1 -U "$(env_get DB_USER)" -d "$(env_get DB_NAME)" \
  -c "SELECT must_change_pw FROM users WHERE role = 'owner' ORDER BY id LIMIT 1" 2>/dev/null || true)"
PASSWORD_LINE="$(journalctl -u ssn-vault-api --no-pager -o cat | grep -E '^\s+Password:' | tail -1 || true)"
if [[ "$MUST_CHANGE" == "1" && -n "$PASSWORD_LINE" ]]; then
  echo "First-run owner account (you must change the password at first sign-in):"
  echo "  Email:   $(env_get OWNER_EMAIL)"
  echo "  $(echo "$PASSWORD_LINE" | sed 's/^ *//')"
fi
cat <<MSG

Services:  systemctl status ssn-vault-api ssn-vault-web
Logs:      journalctl -u ssn-vault-api -f
Update:    git pull && sudo NODE_BIN="\$(command -v node)" deploy/install.sh
MSG
