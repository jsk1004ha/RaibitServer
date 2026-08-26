#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() {
  printf '[raibitserver-auto-update-install] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "run this installer with sudo/root"
fi

TARGET_USER="${1:-${SUDO_USER:-}}"
[[ -n "$TARGET_USER" && "$TARGET_USER" != root ]] \
  || fail "usage: sudo bash deploy/production/install-auto-update.sh <server-user>"

id "$TARGET_USER" >/dev/null 2>&1 || fail "user does not exist: $TARGET_USER"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_GROUP="$(id -gn "$TARGET_USER")"
[[ -n "$TARGET_HOME" && -d "$TARGET_HOME" ]] || fail "home directory not found for $TARGET_USER"

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UPDATER_SOURCE="${SOURCE_DIR}/auto-update.sh"
[[ -f "$UPDATER_SOURCE" ]] || fail "auto-update.sh is missing next to the installer"

VALUES_FILE="${RAIBITSERVER_VALUES_FILE:-${TARGET_HOME}/production-values.yaml}"
KUBECONFIG_FILE="${RAIBITSERVER_KUBECONFIG:-${TARGET_HOME}/.kube/config}"
CONFIG_DIR="${TARGET_HOME}/.config/raibitserver"
STATE_DIR="${TARGET_HOME}/.local/state/raibitserver-auto-update"
DEPLOY_ROOT="${TARGET_HOME}/.local/share/raibitserver-production"
LIBEXEC_DIR="${TARGET_HOME}/.local/libexec"
UPDATER_INSTALLED="${LIBEXEC_DIR}/raibitserver-production-auto-update"
ENV_FILE="${CONFIG_DIR}/auto-update.env"
SERVICE_NAME="raibitserver-auto-update.service"
TIMER_NAME="raibitserver-auto-update.timer"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
TIMER_PATH="/etc/systemd/system/${TIMER_NAME}"

[[ -f "$VALUES_FILE" ]] || fail "production values file does not exist: $VALUES_FILE"
[[ -f "$KUBECONFIG_FILE" ]] || fail "kubeconfig does not exist: $KUBECONFIG_FILE"

install -d -m 700 -o "$TARGET_USER" -g "$TARGET_GROUP" \
  "$CONFIG_DIR" "$STATE_DIR" "$DEPLOY_ROOT" "$LIBEXEC_DIR"
install -m 0755 -o "$TARGET_USER" -g "$TARGET_GROUP" \
  "$UPDATER_SOURCE" "$UPDATER_INSTALLED"

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<EOF
# Non-secret production auto-update configuration.
RAIBITSERVER_GITHUB_REPOSITORY=jsk1004ha/RaibitServer
RAIBITSERVER_REPO_URL=https://github.com/jsk1004ha/RaibitServer.git
RAIBITSERVER_DEPLOY_BRANCH=main
RAIBITSERVER_DEPLOY_ROOT=${DEPLOY_ROOT}
RAIBITSERVER_AUTO_UPDATE_STATE_DIR=${STATE_DIR}
RAIBITSERVER_VALUES_FILE=${VALUES_FILE}
RAIBITSERVER_KUBECONFIG=${KUBECONFIG_FILE}
RAIBITSERVER_HELM_RELEASE=raibitserver
RAIBITSERVER_NAMESPACE=raibitserver-system
RAIBITSERVER_BUILDX_BUILDER=raibit-prod-builder
RAIBITSERVER_BUILD_PLATFORM=linux/amd64
RAIBITSERVER_IMAGE_PREFIX=ghcr.io/jsk1004ha/raibitserver
RAIBITSERVER_COSIGN_KEY=k8s://raibitserver-system/raibitserver-cosign-signing
RAIBITSERVER_HELM_TIMEOUT=20m
EOF
  chown "$TARGET_USER:$TARGET_GROUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  log "preserving existing configuration: $ENV_FILE"
fi

if ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -Fxq docker; then
  if getent group docker >/dev/null; then
    usermod -aG docker "$TARGET_USER"
    log "added $TARGET_USER to the docker group"
  else
    fail "docker group does not exist"
  fi
fi

if ! runuser -u "$TARGET_USER" -- test -r "$VALUES_FILE"; then
  fail "$TARGET_USER cannot read $VALUES_FILE"
fi
if ! runuser -u "$TARGET_USER" -- test -w "$VALUES_FILE"; then
  fail "$TARGET_USER cannot write $VALUES_FILE"
fi
if ! runuser -u "$TARGET_USER" -- test -r "$KUBECONFIG_FILE"; then
  fail "$TARGET_USER cannot read $KUBECONFIG_FILE"
fi

cat >"$SERVICE_PATH" <<EOF
[Unit]
Description=RaibitServer CI-gated production auto update
Documentation=https://github.com/jsk1004ha/RaibitServer/tree/main/deploy/production
Wants=network-online.target
After=network-online.target docker.service k3s.service

[Service]
Type=oneshot
User=${TARGET_USER}
Group=${TARGET_GROUP}
SupplementaryGroups=docker
Environment=HOME=${TARGET_HOME}
Environment=KUBECONFIG=${KUBECONFIG_FILE}
EnvironmentFile=-${ENV_FILE}
WorkingDirectory=${TARGET_HOME}
ExecStart=${UPDATER_INSTALLED}
TimeoutStartSec=2h
KillMode=mixed
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=6
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat >"$TIMER_PATH" <<EOF
[Unit]
Description=Check RaibitServer main for a CI-approved production update

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min
RandomizedDelaySec=30s
AccuracySec=30s
Persistent=true
Unit=${SERVICE_NAME}

[Install]
WantedBy=timers.target
EOF

chmod 0644 "$SERVICE_PATH" "$TIMER_PATH"
systemctl daemon-reload
systemctl enable --now "$TIMER_NAME"

# Trigger the first check immediately without making the installer wait for all
# production image builds to finish.
systemctl start --no-block "$SERVICE_NAME"

log "installed and enabled ${TIMER_NAME}"
log "the first CI-gated update check has been queued"
log "status: systemctl status ${SERVICE_NAME}"
log "logs:   journalctl -u ${SERVICE_NAME} -f"
