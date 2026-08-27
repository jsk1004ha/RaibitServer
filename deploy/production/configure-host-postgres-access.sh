#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() {
  printf '[raibitserver-postgres-access] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

write_listen_sql() {
  local value="$1"
  local destination="$2"
  python3 - "$value" "$destination" <<'PY'
from pathlib import Path
import sys

value, destination = sys.argv[1:]
escaped = value.replace("'", "''")
Path(destination).write_text(
    f"ALTER SYSTEM SET listen_addresses = '{escaped}';\n",
    encoding='utf-8',
)
PY
  chmod 600 "$destination"
}

if [[ "${EUID}" -eq 0 ]]; then
  fail "run this script as the server user, without sudo bash; it requests sudo only for PostgreSQL changes"
fi

for command_name in kubectl python3 sudo mktemp chmod date; do
  require_command "$command_name"
done

: "${HOME:?HOME is required}"
KUBECONFIG="${KUBECONFIG:-${RAIBITSERVER_KUBECONFIG:-${HOME}/.kube/config}}"
NAMESPACE="${RAIBITSERVER_NAMESPACE:-raibitserver-system}"
DATABASE_SECRET="${RAIBITSERVER_DATABASE_SECRET:-raibitserver-control-plane-database}"
DATABASE_URL_KEY="${RAIBITSERVER_DATABASE_URL_KEY:-DATABASE_URL}"
POSTGRES_SERVICE="${RAIBITSERVER_POSTGRES_SERVICE:-postgresql}"

[[ "$POSTGRES_SERVICE" =~ ^[A-Za-z0-9@_.-]+$ ]] \
  || fail "invalid PostgreSQL systemd service name"
[[ -r "$KUBECONFIG" ]] || fail "kubeconfig is not readable: $KUBECONFIG"
export KUBECONFIG

RUN_DIR="$(mktemp -d)"
HBA_FILE=""
HBA_BACKUP=""
ORIGINAL_LISTEN=""
POSTGRES_CHANGED=0

cleanup() {
  rm -rf -- "$RUN_DIR"
}

rollback() {
  local status=$?
  trap - ERR
  set +e
  if [[ "$POSTGRES_CHANGED" == 1 ]]; then
    log "rolling back PostgreSQL network configuration"
    if [[ -n "$HBA_BACKUP" && -n "$HBA_FILE" ]]; then
      sudo cp --preserve=all -- "$HBA_BACKUP" "$HBA_FILE"
    fi
    if [[ -n "$ORIGINAL_LISTEN" ]]; then
      write_listen_sql "$ORIGINAL_LISTEN" "${RUN_DIR}/rollback-listen.sql"
      sudo -u postgres psql --no-psqlrc --set=ON_ERROR_STOP=1 \
        <"${RUN_DIR}/rollback-listen.sql"
    fi
    sudo systemctl restart "$POSTGRES_SERVICE"
    log "rollback attempted; backup retained at ${HBA_BACKUP:-unknown}"
  fi
  exit "$status"
}

trap cleanup EXIT
trap rollback ERR

SECRET_JSON="${RUN_DIR}/database-secret.json"
DB_META="${RUN_DIR}/database-meta"
NODES_JSON="${RUN_DIR}/nodes.json"
NODE_META="${RUN_DIR}/node-meta"

kubectl -n "$NAMESPACE" get secret "$DATABASE_SECRET" -o json >"$SECRET_JSON" \
  || fail "could not read the control-plane database Secret"

# Parse only the non-secret routing fields. The URL and password are never
# printed, copied to argv, or written outside this mode-0700 temporary directory.
python3 - "$SECRET_JSON" "$DATABASE_URL_KEY" >"$DB_META" <<'PY'
from base64 import b64decode
import ipaddress
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

secret_path, key = sys.argv[1:]
secret = json.loads(Path(secret_path).read_text(encoding='utf-8'))
encoded = secret.get('data', {}).get(key)
if not isinstance(encoded, str) or not encoded:
    raise SystemExit(f'database Secret is missing key {key}')
try:
    raw_url = b64decode(encoded, validate=True).decode('utf-8')
except Exception as error:
    raise SystemExit('database Secret URL is not valid base64 UTF-8') from error

parsed = urlsplit(raw_url)
if parsed.scheme not in {'postgres', 'postgresql'}:
    raise SystemExit('database Secret must contain a PostgreSQL URL')
if not parsed.hostname or parsed.username is None:
    raise SystemExit('database URL must include a host and user')
try:
    host_ip = ipaddress.ip_address(parsed.hostname)
except ValueError as error:
    raise SystemExit('host PostgreSQL setup requires a literal node InternalIP') from error
if not host_ip.is_private or host_ip.is_loopback or host_ip.is_unspecified:
    raise SystemExit('PostgreSQL host must be a private, non-loopback node InternalIP')
try:
    port = parsed.port or 5432
except ValueError as error:
    raise SystemExit('database URL has an invalid port') from error
if not 1 <= port <= 65535:
    raise SystemExit('database port must be between 1 and 65535')

username = unquote(parsed.username)
database = unquote(parsed.path.lstrip('/'))
safe_token = re.compile(r'^[A-Za-z_][A-Za-z0-9_.-]{0,62}$')
if not safe_token.fullmatch(username):
    raise SystemExit('database user is not safe for a managed pg_hba rule')
if not safe_token.fullmatch(database):
    raise SystemExit('database name is not safe for a managed pg_hba rule')

print(host_ip.compressed)
print(port)
print(username)
print(database)
PY

mapfile -t DB_FIELDS <"$DB_META"
[[ "${#DB_FIELDS[@]}" -eq 4 ]] || fail "could not parse database routing metadata"
DB_HOST="${DB_FIELDS[0]}"
DB_PORT="${DB_FIELDS[1]}"
DB_USER="${DB_FIELDS[2]}"
DB_NAME="${DB_FIELDS[3]}"

kubectl get nodes -o json >"$NODES_JSON" || fail "could not read Kubernetes node networking"
python3 - "$NODES_JSON" "$DB_HOST" >"$NODE_META" <<'PY'
import ipaddress
import json
from pathlib import Path
import sys

nodes_path, database_host = sys.argv[1:]
nodes = json.loads(Path(nodes_path).read_text(encoding='utf-8')).get('items', [])
matches = []
pod_networks = set()

for node in nodes:
    name = node.get('metadata', {}).get('name', '')
    internal_ips = {
        address.get('address')
        for address in node.get('status', {}).get('addresses', [])
        if address.get('type') == 'InternalIP'
    }
    if database_host in internal_ips:
        matches.append(name)

    spec = node.get('spec', {})
    cidrs = spec.get('podCIDRs') or ([spec.get('podCIDR')] if spec.get('podCIDR') else [])
    for raw_cidr in cidrs:
        try:
            network = ipaddress.ip_network(raw_cidr, strict=True)
        except ValueError as error:
            raise SystemExit(f'node {name} has an invalid Pod CIDR') from error
        if network.version != ipaddress.ip_address(database_host).version:
            continue
        if not network.is_private or network.is_loopback or network.is_unspecified:
            raise SystemExit(f'node {name} Pod CIDR must be private')
        pod_networks.add(network.with_prefixlen)

if len(matches) != 1:
    raise SystemExit('database host must match exactly one Kubernetes node InternalIP')
if not pod_networks:
    raise SystemExit('Kubernetes nodes do not publish a compatible podCIDR/podCIDRs value')
if len(pod_networks) > 64:
    raise SystemExit('refusing to manage more than 64 Pod CIDRs')

print(matches[0])
for network in sorted(pod_networks, key=lambda value: ipaddress.ip_network(value)):
    print(network)
PY

mapfile -t NODE_FIELDS <"$NODE_META"
[[ "${#NODE_FIELDS[@]}" -ge 2 ]] || fail "could not resolve the node and Pod CIDRs"
DATABASE_NODE="${NODE_FIELDS[0]}"
POD_CIDRS=("${NODE_FIELDS[@]:1}")

log "database endpoint ${DB_HOST}:${DB_PORT} belongs to node ${DATABASE_NODE}"
log "authorizing ${#POD_CIDRS[@]} validated private Pod CIDR(s) for database ${DB_NAME}"

PSQL=(sudo -u postgres psql --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align)
HBA_FILE="$("${PSQL[@]}" --command='SHOW hba_file;')"
ORIGINAL_LISTEN="$("${PSQL[@]}" --command='SHOW listen_addresses;')"
[[ "$HBA_FILE" == /* ]] || fail "PostgreSQL returned a non-absolute pg_hba path"
[[ -n "$ORIGINAL_LISTEN" ]] || fail "PostgreSQL returned an empty listen_addresses value"

sudo python3 - "$HBA_FILE" <<'PY'
from pathlib import Path
import stat
import sys

path = Path(sys.argv[1])
metadata = path.lstat()
if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
    raise SystemExit('pg_hba.conf must be a regular non-symlink file')
if metadata.st_mode & stat.S_IWOTH:
    raise SystemExit('pg_hba.conf must not be world writable')
PY

BASELINE_HBA_ERRORS="$("${PSQL[@]}" --command='SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;')"
[[ "$BASELINE_HBA_ERRORS" == 0 ]] || fail "existing pg_hba.conf has parse errors; refusing to edit it"
BROAD_HBA_RULES="$("${PSQL[@]}" --command="
SELECT count(*)
FROM pg_hba_file_rules
WHERE type LIKE 'host%'
  AND auth_method IS DISTINCT FROM 'reject'
  AND (
    address IS NULL
    OR lower(address) = 'all'
    OR (address = '0.0.0.0' AND netmask = '0.0.0.0')
    OR (address = '::' AND netmask = '::')
  );
")"
[[ "$BROAD_HBA_RULES" == 0 ]] \
  || fail "existing pg_hba.conf contains a wildcard host rule; refusing to open the private listener"

NEXT_LISTEN="$(python3 - "$ORIGINAL_LISTEN" "$DB_HOST" <<'PY'
import ipaddress
import sys

current, database_host = sys.argv[1:]
entries = [entry.strip() for entry in current.split(',') if entry.strip()]
if not entries:
    entries = ['127.0.0.1']
for entry in entries:
    if entry == '*':
        raise SystemExit('refusing to preserve a wildcard PostgreSQL listener')
    if entry == 'localhost':
        continue
    try:
        address = ipaddress.ip_address(entry)
    except ValueError as error:
        raise SystemExit(f'unsupported listen_addresses entry: {entry}') from error
    if address.is_unspecified or (not address.is_private and not address.is_loopback):
        raise SystemExit(f'refusing to preserve a public PostgreSQL listener: {entry}')
if database_host not in entries:
    entries.append(database_host)
print(','.join(entries))
PY
)"

RULES_FILE="${RUN_DIR}/pg-hba-managed.rules"
python3 - "$DB_NAME" "$DB_USER" "${POD_CIDRS[@]}" >"$RULES_FILE" <<'PY'
import sys

database, username, *cidrs = sys.argv[1:]
print('# BEGIN RAIBITSERVER MANAGED K3S POD ACCESS')
for cidr in cidrs:
    print(f'host {database} {username} {cidr} scram-sha-256')
print('# END RAIBITSERVER MANAGED K3S POD ACCESS')
PY
chmod 600 "$RULES_FILE"

HBA_BACKUP="${HBA_FILE}.raibitserver.$(date -u +%Y%m%dT%H%M%SZ).$$.bak"
sudo cp --preserve=all -- "$HBA_FILE" "$HBA_BACKUP"
POSTGRES_CHANGED=1

sudo python3 - "$HBA_FILE" "$RULES_FILE" <<'PY'
import os
from pathlib import Path
import stat
import sys

target = Path(sys.argv[1])
rules_path = Path(sys.argv[2])
begin = '# BEGIN RAIBITSERVER MANAGED K3S POD ACCESS'
end = '# END RAIBITSERVER MANAGED K3S POD ACCESS'

metadata = target.lstat()
if not stat.S_ISREG(metadata.st_mode) or target.is_symlink():
    raise SystemExit('pg_hba.conf changed type before update')
original = target.read_text(encoding='utf-8')
rules = rules_path.read_text(encoding='utf-8').rstrip() + '\n'
start_count = original.count(begin)
end_count = original.count(end)
if start_count != end_count or start_count > 1:
    raise SystemExit('pg_hba.conf contains an ambiguous RAIBITSERVER managed block')

if start_count == 1:
    start = original.index(begin)
    finish = original.index(end, start) + len(end)
    while finish < len(original) and original[finish] in '\r\n':
        finish += 1
    updated = original[:start] + rules + original[finish:]
else:
    separator = '' if not original or original.endswith('\n') else '\n'
    updated = original + separator + rules

temporary = target.with_name(f'.{target.name}.raibitserver.{os.getpid()}.tmp')
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
if hasattr(os, 'O_NOFOLLOW'):
    flags |= os.O_NOFOLLOW
try:
    descriptor = os.open(temporary, flags, stat.S_IMODE(metadata.st_mode))
    try:
        os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        encoded = updated.encode('utf-8')
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    for attribute in os.listxattr(target, follow_symlinks=False):
        os.setxattr(
            temporary,
            attribute,
            os.getxattr(target, attribute, follow_symlinks=False),
            follow_symlinks=False,
        )
    os.replace(temporary, target)
except BaseException:
    try:
        temporary.unlink(missing_ok=True)
    finally:
        raise
directory_fd = os.open(target.parent, os.O_RDONLY | os.O_CLOEXEC)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY

write_listen_sql "$NEXT_LISTEN" "${RUN_DIR}/set-listen.sql"
"${PSQL[@]}" <"${RUN_DIR}/set-listen.sql"
"${PSQL[@]}" --command='SELECT pg_reload_conf();' >/dev/null
HBA_ERRORS="$("${PSQL[@]}" --command='SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;')"
[[ "$HBA_ERRORS" == 0 ]] || fail "managed pg_hba rules failed PostgreSQL validation"

sudo systemctl restart "$POSTGRES_SERVICE"
sudo systemctl is-active --quiet "$POSTGRES_SERVICE" \
  || fail "PostgreSQL did not return to active state"

ACTIVE_LISTEN="$("${PSQL[@]}" --command='SHOW listen_addresses;')"
python3 - "$ACTIVE_LISTEN" "$DB_HOST" <<'PY'
import sys

active, expected = sys.argv[1:]
entries = {entry.strip() for entry in active.split(',') if entry.strip()}
if expected not in entries:
    raise SystemExit('PostgreSQL did not activate the private node listener')
PY

python3 - "$DB_HOST" "$DB_PORT" <<'PY'
import socket
import sys

host, raw_port = sys.argv[1:]
with socket.create_connection((host, int(raw_port)), timeout=5):
    pass
print(f'TCP_OK {host}:{raw_port}')
PY

PODS_JSON="${RUN_DIR}/api-pods.json"
kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=api -o json >"$PODS_JSON"
API_POD="$(python3 - "$PODS_JSON" <<'PY'
import json
from pathlib import Path
import sys

pods = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')).get('items', [])
for pod in pods:
    ready = any(
        condition.get('type') == 'Ready' and condition.get('status') == 'True'
        for condition in pod.get('status', {}).get('conditions', [])
    )
    if pod.get('status', {}).get('phase') == 'Running' and ready:
        print(pod.get('metadata', {}).get('name', ''))
        break
PY
)"

if [[ -n "$API_POD" ]]; then
  kubectl -n "$NAMESPACE" exec "$API_POD" -c api -- node -e '
const net = require("node:net");
const [host, rawPort] = process.argv.slice(1);
const port = Number(rawPort);
const socket = net.connect({ host, port });
socket.setTimeout(5000);
socket.once("connect", () => { console.log(`TCP_OK ${host}:${port}`); socket.end(); });
socket.once("timeout", () => { console.error("TCP_TIMEOUT"); socket.destroy(); process.exitCode = 2; });
socket.once("error", (error) => { console.error(`TCP_ERROR ${error.code || error.name}`); process.exitCode = 1; });
' "$DB_HOST" "$DB_PORT"

  kubectl -n "$NAMESPACE" exec "$API_POD" -c api -- node -e '
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
const { PrismaClient } = require("@prisma/client");
const client = new PrismaClient();
const deadline = setTimeout(() => {
  console.error("DB_QUERY_FAILED timeout");
  process.exit(2);
}, 15000);
(async () => {
  try {
    await client.$queryRawUnsafe("SELECT 1");
    console.log("DB_QUERY_OK");
  } catch (error) {
    console.error(`DB_QUERY_FAILED ${error.code || error.name}`);
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
    clearTimeout(deadline);
  }
})();
'
else
  log "no ready API Pod exists yet; skipped the in-cluster authentication check"
fi

POSTGRES_CHANGED=0
trap - ERR
log "PostgreSQL now accepts authenticated control-plane traffic only from validated Pod CIDRs"
log "pg_hba backup retained at ${HBA_BACKUP}"
