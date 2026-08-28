# RAIBITSERVER 문서 허브

RAIBITSERVER 문서는 README를 짧은 진입점으로 유지하고, 세부 설명을 목적별 문서로 분리합니다. 처음 보는 사람은 [처음 사용 가이드](getting-started.md)를 순서대로 따라간 뒤 필요한 운영 문서로 이동하면 됩니다.

## 빠른 길찾기

| 상황 | 먼저 볼 문서 |
| --- | --- |
| 사람 또는 AI가 전체 사용·배포 기준을 한 번에 보고 싶다 | [사용·배포 총집본](handbook/README.md) |
| 설치부터 첫 배포까지 천천히 따라 하고 싶다 | [처음 사용 가이드](getting-started.md) |
| 프로젝트가 무엇인지 알고 싶다 | [README](../README.md), [아키텍처](architecture.md) |
| 로컬에서 검증하고 싶다 | [로컬 E2E](local-e2e.md), [검증 명령](verification-commands.md) |
| 실제 클러스터 smoke test가 필요하다 | [Live E2E](live-e2e.md) |
| 배포/운영 준비가 필요하다 | [Staging 배포](../deploy/staging/README.md), [Production 배포](../deploy/production/README.md) |
| Cloudflare Tunnel로 공개하고 싶다 | [Cloudflare Tunnel 운영](cloudflare-tunnel.md), [Production 배포](../deploy/production/README.md) |
| GitHub 연동과 PR preview를 봐야 한다 | [GitHub App](github-app.md), [Preview Deployment](preview-deployments.md) |
| 보안/권한/쿼터를 확인해야 한다 | [보안](security.md), [승인·쿼터](quota.md) |
| DB와 리소스 동작을 확인해야 한다 | [프로비저닝](provisioning.md), [DB Console](db-console.md) |
| 베타 출시 가능 여부를 판단해야 한다 | [Closed Beta 기준](beta-criteria.md) |
| 문제가 발생했다 | [문제 해결](troubleshooting.md) |

## 문서 목록

| 문서 | 목적 | 주요 독자 |
| --- | --- | --- |
| [handbook/README.md](handbook/README.md) | 배포 조건, 사용자·운영자·AI 설명서의 중앙 목차 | 모든 사용자, AI |
| [handbook/deployment-requirements.md](handbook/deployment-requirements.md) | tenant 앱의 계정·소스·컨테이너·보안·DB 배포 조건 | 앱 개발자, AI |
| [handbook/user-guide.md](handbook/user-guide.md) | 가입부터 생성·배포·업데이트·삭제까지 웹 콘솔 절차 | 일반 사용자 |
| [handbook/operator-guide.md](handbook/operator-guide.md) | 승인, 상태, 장애, 리소스, production 운영 절차 | 관리자, 운영자 |
| [handbook/ai-guide.md](handbook/ai-guide.md) | AI의 신뢰 경계, 안전한 API·배포·검증·보고 계약 | AI, AI 사용자 |
| [getting-started.md](getting-started.md) | 설치, 4단계 프로젝트 생성, 자동 감지, secret, AI 배포, 밴, 자동 업데이트를 화면 순서대로 설명 | 처음 사용하는 사용자, 운영자 |
| [architecture.md](architecture.md) | TypeScript 제어 평면과 Go reconcilers 구조 설명 | 개발자, 운영자 |
| [local-e2e.md](local-e2e.md) | 외부 부작용 없는 dry-run E2E 실행법 | 개발자, CI 관리자 |
| [live-e2e.md](live-e2e.md) | Docker/kind·k3d/kubectl 기반 live E2E 절차 | 운영자, 릴리스 담당자 |
| [verification-commands.md](verification-commands.md) | 변경 영역별 검증 명령 매트릭스 | 모든 기여자 |
| [cloudflare-tunnel.md](cloudflare-tunnel.md) | Tunnel wildcard routing, Access, cache/WAF, TCP 공개 금지, origin-bypass guardrail | 운영자, 보안 담당자 |
| [github-app.md](github-app.md) | GitHub App/OAuth/webhook 계약 | 개발자, 운영자 |
| [preview-deployments.md](preview-deployments.md) | PR preview URL과 cleanup 모델 | 개발자, QA |
| [security.md](security.md) | workload, secret, DB console 보안 정책 | 보안/운영 담당자 |
| [quota.md](quota.md) | 사용자 승인과 사용량 제한 모델 | 운영자, API 개발자 |
| [db-console.md](db-console.md) | DB/resource console 지원 범위와 guard | 제품/백엔드 개발자 |
| [provisioning.md](provisioning.md) | 관리형 리소스 desired-state plan과 provider mode | 인프라 개발자 |
| [workflows.md](workflows.md) | `WorkflowJob` claim/retry/idempotency 계약 | 백엔드/Go 서비스 개발자 |
| [troubleshooting.md](troubleshooting.md) | 자주 발생하는 실패와 해결 순서 | 모든 사용자 |
| [beta-criteria.md](beta-criteria.md) | Closed Beta 출시 gate와 P0 체크리스트 | 제품/운영/QA |

## 작성 규칙

- 문서는 항상 현재 구현과 맞아야 합니다.
- README에는 목적, 빠른 시작, 필수 검증, 주요 링크만 둡니다.
- 긴 설명은 목적별 문서로 분리하고 README 또는 이 문서에서 링크합니다.
- 명령어는 복사해서 실행할 수 있게 코드 블록으로 둡니다.
- 제한 사항과 known gap은 숨기지 않고 문서 하단에 명시합니다.

이 구조는 InfoGrab의 [좋은 README 작성하는 방법](https://insight.infograb.net/blog/2023/08/23/good-readme/)에서 강조한 최신성, 간결성, 목적별 링크 분리 원칙을 반영합니다.
