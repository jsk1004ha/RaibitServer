# 변경 이력

이 문서는 사용자와 운영자가 확인해야 할 주요 변경 사항을 요약합니다. 상세 구현 이력은 Git commit과 release tag를 함께 확인하세요.

## Unreleased

### 보안

- 앱/preview/console/resource hostname과 Kubernetes namespace의 tenant-project label에서 user와 project slug 사이를 `--`로 구분해, 하이픈이 포함된 slug 조합 간 Host/Ingress 충돌을 차단했습니다.
- 동일 이메일 signup을 다시 시작하면 기존 pending signup 인증 코드와 payload를 무효화하고, pending 조회는 만료되지 않은 코드만 반환하도록 수정해 악의적 pre-registration payload가 피해자 가입을 차단하거나 인증 후 적용되는 계정 탈취 경로를 차단했습니다.
- 빌드 실행 시 tenant 입력 경로(`localPath`, `buildContext`, `dockerfilePath`)를 workspace/source 디렉터리 경계 안의 안전한 상대 경로로만 해석하도록 강제했습니다.
- Go builder 엔트리포인트/worker 양쪽에 경로 이탈 및 절대 경로 Dockerfile 주입 차단 회귀 테스트를 추가해 실제 `docker buildx` 실행 경계에서 호스트 파일 노출을 차단했습니다.
- 리소스 프로비저닝 경로에서 PostgreSQL `providerAdminUrl/adminUrl` 및 `host/port`를 요청 본문으로 덮어쓸 수 없도록 차단하고, 라이브 실행(`execute=true`,`dryRun=false`)은 `RAIBITSERVER_ENABLE_LIVE_PROVIDER_PROVISIONING=true`가 설정된 경우에만 허용하도록 변경했습니다.
- GitHub webhook 처리 경로를 fail-closed로 변경해 webhook secret(`RAIBITSERVER_GITHUB_WEBHOOK_SECRET` 또는 `GITHUB_WEBHOOK_SECRET`)이 없으면 요청을 거부하도록 수정했습니다.

### 문서

- README를 한국어 진입 문서로 재작성했습니다.
- 목적별 문서 허브(`docs/README.md`)를 추가하고 README에서 세부 문서로 연결했습니다.
- 운영, 보안, E2E, 프로비저닝, GitHub, DB console 문서를 한국어 중심 구조로 정리했습니다.

## 0.1.0

### 플랫폼 골격

- TypeScript 중심 monorepo와 Go 인프라 서비스 구조를 도입했습니다.
- 프로젝트, 서비스, 배포, 관리형 리소스, 승인/쿼터, preview deployment의 로컬 검증 계약을 제공합니다.
- 외부 credential 없이 실행 가능한 deterministic dry-run E2E 경로를 제공합니다.
