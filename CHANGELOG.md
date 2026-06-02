# 변경 이력

이 문서는 사용자와 운영자가 확인해야 할 주요 변경 사항을 요약합니다. 상세 구현 이력은 Git commit과 release tag를 함께 확인하세요.

## Unreleased

### 보안

- 이메일 인증이 완료되지 않은 동일 이메일 signup을 새 payload로 덮어쓰지 않고 거부해, 공격자가 피해자의 pending signup 비밀번호/조직 정보를 교체하는 계정 탈취 경로를 차단했습니다.
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
