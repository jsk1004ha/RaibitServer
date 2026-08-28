# RAIBITSERVER 사용·배포 총집본

이 문서는 RAIBITSERVER에 애플리케이션을 올리는 사람, 서비스를 운영하는 관리자, 작업을 대신 수행하는 AI가 같은 기준을 보도록 만든 중앙 안내서입니다.

RAIBITSERVER는 코드를 그대로 실행하지 않습니다. 소스를 컨테이너 이미지로 만들고, 보안 검사를 거쳐 Kubernetes 실행 상태로 배포합니다. 데이터베이스·캐시·스토리지는 별도 관리형 리소스로 연결합니다.

## 독자별 시작점

| 하고 싶은 일 | 먼저 읽을 문서 |
| --- | --- |
| 내 앱을 올릴 수 있는지 확인 | [배포 조건](deployment-requirements.md) |
| 가입부터 첫 배포까지 따라 하기 | [사용자 설명서](user-guide.md) |
| 서버 상태·장애·백업·삭제 관리 | [운영자 설명서](operator-guide.md) |
| AI에게 개발·배포·점검 맡기기 | [AI 설명서](ai-guide.md) |
| 플랫폼 자체를 개발·검증 | [AI 설명서의 플랫폼 작업](ai-guide.md#플랫폼-저장소를-수정하는-ai)과 [검증 명령](../verification-commands.md) |

## 공식 서비스 주소

| 기능 | 주소 |
| --- | --- |
| 메인 | <https://raibit.kr/> |
| 로그인·콘솔 | <https://console.raibit.kr/> |
| 가입 신청 | <https://console.raibit.kr/login?mode=signup> |
| 사용 안내 | <https://console.raibit.kr/guide> |
| 시스템 상태 | <https://raibit.kr/status> |
| 지원 | <https://raibit.kr/support> |
| 개인정보처리방침 | <https://raibit.kr/privacy> |
| 코드·이슈 | <https://github.com/jsk1004ha/RaibitServer> |

운영 환경의 base domain은 `raibit.kr`입니다. 소스 코드의 로컬 기본값은 `raibitserver.local`, 일부 계획 함수의 기본값은 `raibitserver.app`이므로 실제 URL은 현재 운영 설정과 콘솔에 표시된 값을 기준으로 판단합니다.

## 가장 짧은 성공 경로

```mermaid
flowchart LR
  A[가입·이메일 인증] --> B[관리자 승인]
  B --> C[프로젝트 생성]
  C --> D[저장소·서비스 설정]
  D --> E[환경 변수·리소스 연결]
  E --> F[운영 배포]
  F --> G[빌드·보안·서명]
  G --> H[READY 확인]
  H --> I[공개 URL·로그·DB 검증]
```

1. 이름, 학번, 이메일, 비밀번호, 동아리원 여부로 가입을 신청합니다.
2. 이메일의 6자리 코드를 인증하고 관리자 승인을 기다립니다.
3. 프로젝트 만들기에서 프로젝트 → 저장소 → 서비스 → 리소스 순으로 입력합니다.
4. 애플리케이션이 `0.0.0.0`의 설정된 포트에서 실행되는지 확인합니다.
5. 비밀값은 Git에 넣지 않고 서비스 환경 변수에서 암호화 저장합니다.
6. 데이터베이스가 필요하면 관리형 리소스를 `READY`까지 기다린 뒤 서비스에 연결합니다.
7. 운영 배포를 요청하고 `READY` 상태, 이미지 digest, 빌드 로그를 확인합니다.
8. `READY`와 별개로 공개 URL, 앱이 제공하는 상태 경로, 실제 데이터 쓰기·읽기를 검증합니다.

## 핵심 용어

| 용어 | 뜻 |
| --- | --- |
| 조직 | 사용자와 프로젝트의 권한 범위 |
| 프로젝트 | 서비스, 리소스, 배포를 묶는 단위 |
| 서비스 | 실행되는 컨테이너. `web`, `private`, `worker`, `cron`, `job` 지원 |
| 리소스 | PostgreSQL, Redis 같은 플랫폼 관리 데이터 계층 |
| 배포 | 특정 소스 revision을 이미지로 만들고 실행 상태로 반영하는 작업 |
| 운영 배포 | 실제 운영 URL을 갱신하는 배포 |
| PR 미리보기 | GitHub PR 번호가 있는 배포를 별도 주소에서 확인하는 기능. 현재 격리는 PR 기반 배포만 보장 |
| desired state | API가 저장하는 사용자의 목표 상태 |
| reconcile | Go 인프라 서비스가 실제 상태를 목표 상태에 맞추는 작업 |

## 절대 지켜야 하는 규칙

- 사용자 Dockerfile이 있으면 자동 프레임워크 감지보다 우선합니다.
- 앱은 컨테이너로 실행되어야 하며 root·privileged·hostPath·host network를 사용할 수 없습니다.
- 앱의 영구 데이터는 컨테이너 로컬 파일이 아니라 관리형 DB 또는 스토리지에 저장합니다.
- 실제 `.env`, token, password, connection string을 Git, 채팅, 로그, 빌드 인자에 넣지 않습니다.
- 리소스 연결 정보는 플랫폼이 만든 Secret reference를 사용합니다.
- 사용자 요청 경로에서 장시간 빌드나 Kubernetes 조작을 직접 실행하지 않습니다.
- 배포 성공은 요청 접수나 `READY` 하나로 판단하지 않습니다. 현재 `READY`는 rollout 상태이며 앱의 HTTP 정상 여부는 공개 URL에서 별도로 확인합니다.
- AI는 보안 차단을 해제하거나 secret을 읽기 위해 우회하지 않습니다.
- 프로젝트·서비스·리소스 삭제와 운영 롤백은 영향 범위를 확인한 뒤 명시적으로 수행합니다.

## 구현 기준과 문서 우선순위

문서와 화면이 다르면 다음 순서로 확인합니다.

1. 현재 배포된 API·Dashboard의 실제 응답
2. `packages/core`와 `apps/api`의 코드 계약
3. [`openapi/raibitserver.yaml`](../../openapi/raibitserver.yaml)
4. 이 총집본
5. 개별 화면의 보조 문구

리소스는 카탈로그에 보인다는 이유만으로 모두 production live 지원이라고 판단하면 안 됩니다. 현재 실제 provider 범위는 [리소스 프로비저닝](../provisioning.md)을 확인합니다.

## 관련 상세 문서

- [처음 사용 가이드](../getting-started.md)
- [시스템 구조](../architecture.md)
- [보안 정책](../security.md)
- [승인과 쿼터](../quota.md)
- [GitHub App](../github-app.md)
- [Preview Deployment](../preview-deployments.md)
- [리소스 프로비저닝](../provisioning.md)
- [DB Console](../db-console.md)
- [문제 해결](../troubleshooting.md)
- [검증 명령](../verification-commands.md)
- [Production 배포](../../deploy/production/README.md)

## 지원 요청에 포함할 정보

### 비공개 지원 메일

계정 확인이나 보안·개인정보가 포함된 문의는 `ishsraibit@gmail.com`으로 보냅니다. 비밀번호, token, Secret 값, 전체 connection string은 메일에도 넣지 않습니다.

- 사용자 이메일 또는 학번
- 프로젝트·서비스 이름
- 배포 ID
- 실패 상태와 오류 코드
- 실패 시각과 재현 순서
- Dockerfile 경로와 build context
- 저장소 URL과 branch, commit SHA
- 비밀값을 제거한 로그의 앞뒤 문맥

### 공개 GitHub Issues

재현 가능한 공개 버그와 기능 제안은 [GitHub Issues](https://github.com/jsk1004ha/RaibitServer/issues)를 사용합니다. 공개 이슈에는 이메일, 학번, 비공개 저장소 URL, 보안 취약점, credential을 올리지 않습니다. 배포 ID와 비식별 오류 코드·로그만 사용합니다.
