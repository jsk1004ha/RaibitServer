#!/usr/bin/env bash
set -euo pipefail
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
evidence=$1
fixtures=$2
scenario=${3:-all}
taskdb=metrics_$(tr -d '-' < /proc/sys/kernel/random/uuid)
cleanup() {
  runuser -u postgres -G jio -- dropdb --if-exists "$taskdb"
  printf 'database=%s cleanup=success\n' "$taskdb" > "$evidence/cleanup.txt"
}
trap cleanup EXIT
runuser -u postgres -G jio -- createdb "$taskdb"
for migration in "$module"/../../prisma/migrations/0000{01,02,03,04,05,06,07,08,09,10,11,12,13}_*/migration.sql; do
  runuser -u postgres -G jio -- psql -X -v ON_ERROR_STOP=1 -d "$taskdb" -f "$migration" >> "$evidence/migrations.txt" 2>&1
done
cd "$module"
export PATH=/usr/local/go/bin:$PATH
/home/jio/raibitwork/b0135017/task11-tools/gofumpt -w .
go build -o "$evidence/metrics-ingester" ./cmd/metrics-ingester
go test -race -c -tags=integration -o "$evidence/store.test" ./internal/store
if [[ "$scenario" == all ]]; then
  go vet -tags=integration ./...
  RAIBITSERVER_IDENTITY_FIXTURE="$fixtures/observability-runtime-identity-v1.json" RAIBITSERVER_REDACTION_FIXTURE="$fixtures/observability-redaction-v1.json" go test -race -shuffle=on -count=1 ./...
  scenario=.
fi
runuser -u postgres -G jio -- env RAIBITSERVER_TEST_DATABASE_URL="host=/var/run/postgresql user=postgres dbname=$taskdb sslmode=disable" RAIBITSERVER_EVIDENCE_DIR="$evidence" RAIBITSERVER_METRICS_BINARY="$evidence/metrics-ingester" "$evidence/store.test" -test.v -test.shuffle=on -test.timeout=120s -test.run="$scenario"
sha256sum "$evidence/metrics-ingester" "$evidence/store.test" "$fixtures/observability-runtime-identity-v1.json" "$fixtures/observability-redaction-v1.json" > "$evidence/native-fixture-hashes.txt"
find internal cmd -name '*.go' -type f -print0 | sort -z | xargs -0 sha256sum > "$evidence/source-hashes.txt"
