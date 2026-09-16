#!/usr/bin/env bash
set -euo pipefail
module=$(realpath "$1")
evidence=$(realpath "$2")
fixtures=$(realpath "$3")
database="task19_logs_$(tr -d '-' </proc/sys/kernel/random/uuid)"
[[ "$database" =~ ^task19_logs_[a-f0-9]{32}$ ]]
cache=$(runuser -u postgres -G jio -- mktemp -d /tmp/task19-logs-cache.XXXXXXXX)
[[ "$cache" == /tmp/task19-logs-cache.* ]]
runuser -u postgres -G jio -- mkdir "$cache/artifacts"
cleanup() {
  cp -a "$cache/artifacts/." "$evidence/"
  if [[ -f "$cache/log-ingester" ]]; then cp "$cache/log-ingester" "$evidence/log-ingester"; fi
  runuser -u postgres -G jio -- dropdb -h /var/run/postgresql --if-exists "$database"
  rm -r -- "$cache"
  printf 'database=%s dropped=true cache_removed=true\n' "$database" >"$evidence/cleanup.log"
}
trap cleanup EXIT
runuser -u postgres -G jio -- createdb -h /var/run/postgresql "$database"
printf 'database=%s schemas=1-13 timezone=UTC\n' "$database" >"$evidence/database.log"
for migration in "$module"/../../prisma/migrations/0000{01,02,03,04,05,06,07,08,09,10,11,12,13}_*/migration.sql; do
  runuser -u postgres -G jio -- psql -X -v ON_ERROR_STOP=1 -h /var/run/postgresql -d "$database" -f "$migration" >>"$evidence/database.log"
done
export RAIBITSERVER_TEST_DATABASE_URL="host=/var/run/postgresql user=postgres dbname=$database timezone=UTC"
export RAIBITSERVER_TEST_BINARY="$cache/log-ingester"
export RAIBITSERVER_EVIDENCE_DIR="$cache/artifacts"
export RAIBITSERVER_OBSERVABILITY_FIXTURES="$fixtures"
export GOCACHE="$cache/go-build"
export GOMODCACHE=/home/jio/go/pkg/mod
cd "$module"
runuser -u postgres -G jio -- /usr/local/go/bin/go build -o "$RAIBITSERVER_TEST_BINARY" ./cmd/log-ingester
runuser -u postgres -G jio -- /usr/local/go/bin/go test -race -shuffle=on -count=1 -v -run "${4:-.}" ./... 2>&1 | tee "$evidence/green.log"
runuser -u postgres -G jio -- /usr/local/go/bin/go vet ./... 2>&1 | tee "$evidence/vet.log"
printf 'go_vet_exit=0\n' >>"$evidence/vet.log"
sha256sum "$RAIBITSERVER_TEST_BINARY" "$fixtures/observability-runtime-identity-v1.json" "$fixtures/observability-redaction-v1.json" >"$evidence/native-fixture-hashes.txt"
find . -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' -o -name '*.sh' \) -print0 | sort -z | xargs -0 sha256sum >"$evidence/source-hashes.txt"
