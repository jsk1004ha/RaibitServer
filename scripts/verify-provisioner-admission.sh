#!/usr/bin/env sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: verify-provisioner-admission.sh <helm-render.yaml> [...]" >&2
  exit 1
fi
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GO=${GO_BIN:-go}
NODE=${NODE_BIN:-node}
PROBE_DIR=$(mktemp -d)
trap 'rm -rf "$PROBE_DIR"' EXIT HUP INT TERM

# A Windows Node can use the existing WSL Go compiler's cross-compiled probe.
node_path() {
  case "$NODE" in
    *.exe) if command -v wslpath >/dev/null 2>&1; then wslpath -w "$1"; else printf '%s\n' "$1"; fi ;;
    *) printf '%s\n' "$1" ;;
  esac
}
PROBE_GOOS=$("$GO" env GOOS)
case "$NODE" in *.exe) PROBE_GOOS=windows ;; esac
(cd "$ROOT_DIR/tests/fixtures/provisioner-admission-cel" && GOOS="$PROBE_GOOS" "$GO" build -mod=readonly -o "$PROBE_DIR/cel-evaluate.exe" .)
(cd "$ROOT_DIR/services/provisioner" && "$GO" test ./internal/backup -run '^Test_RecoveryNetworkPolicyManifest_emits_admission_fixture$' -count=1 -v) >"$PROBE_DIR/generated.log"
(cd "$ROOT_DIR/services/provisioner" && "$GO" test ./internal/command -run '^TestRecoveryUIDDeletesUseBackgroundPropagationAndAcceptAsyncResponse$' -count=1 -v) >"$PROBE_DIR/delete-options.log"
sed -n 's/^.*BOUNDARY_FIXTURE=//p' "$PROBE_DIR/generated.log" >"$PROBE_DIR/recovery.json"
test -s "$PROBE_DIR/recovery.json"

cd "$ROOT_DIR"
for render in "$@"; do
  "$NODE" tests/fixtures/provisioner-security-cel.mjs "$(node_path "$render")" "$(node_path "$PROBE_DIR/cel-evaluate.exe")" "$(node_path "$PROBE_DIR/recovery.json")"
done
