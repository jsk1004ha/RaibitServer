# RAIBITSERVER 처음 사용 가이드

이 문서는 RAIBITSERVER를 처음 접한 사용자가 저장소를 준비하고, 프로젝트를 만들고, 비밀키와 데이터베이스를 연결한 다음 안전하게 첫 배포를 실행하는 과정을 설명합니다. 명령어를 많이 아는 사람을 전제로 하지 않습니다. 화면에 보이는 용어와 실제로 일어나는 일을 함께 풀어 설명합니다.

> 빠르게 확인만 하고 싶다면 `pnpm install --frozen-lockfile` 뒤에 `pnpm e2e:dry`를 실행하세요. 이 검증은 실제 Kubernetes, 클라우드, 레지스트리 자격 증명 없이 동작합니다.

## 1. RAIBITSERVER가 하는 일

RAIBITSERVER에서 **프로젝트**는 한 개의 저장소나 서버 한 대를 뜻하지 않습니다. 동아리 웹사이트를 예로 들면, 사용자에게 보이는 웹 서비스, 백그라운드 작업을 처리하는 worker, 매일 정해진 시각에 실행되는 cron, PostgreSQL 데이터베이스를 하나의 프로젝트에 함께 둘 수 있습니다.

각 서비스는 최종적으로 컨테이너 이미지와 Kubernetes 실행 상태로 변환됩니다. API는 사용자가 원하는 상태를 데이터베이스에 기록하고, Go로 작성된 builder와 orchestrator, provisioner가 실제 상태를 맞춥니다. 그래서 대시보드 요청이 오래 열린 채로 빌드나 Kubernetes 작업을 직접 수행하지 않습니다.

처음에는 다음 네 가지 개념만 기억하면 됩니다.

- **프로젝트**: 서비스와 리소스를 묶는 가장 큰 단위입니다.
- **서비스**: web, private, worker, cron, job처럼 실행되는 프로그램입니다.
- **리소스**: PostgreSQL, Redis, Object Storage처럼 플랫폼이 관리하는 데이터 계층입니다.
- **배포**: 저장소나 이미지를 실제 실행 상태로 바꾸는 작업 기록입니다.

## 2. 로컬에서 안전하게 확인하기

### 필요한 프로그램

Node.js 24 이상과 pnpm 11.1.2가 필요합니다. Git도 설치되어 있어야 합니다. Docker, Kubernetes, Go는 실제 클러스터 검증에만 필요하므로 처음부터 설치하지 않아도 됩니다.

```sh
node --version
corepack enable
pnpm --version
```

Node 버전이 24보다 낮으면 먼저 Node를 업그레이드하세요. 이 저장소는 로컬 DB console에서 Node 24의 `node:sqlite` 기능을 사용합니다.

### 저장소 설치와 dry-run

```sh
git clone https://github.com/jsk1004ha/RaibitServer.git
cd RaibitServer
corepack enable
pnpm install --frozen-lockfile
pnpm dev:up
pnpm dev:seed
pnpm e2e:dry
```

`pnpm dev:up`은 현재 컴퓨터에 Docker, kubectl, kind, Go 같은 도구가 있는지 확인하고 로컬 작업 상태를 준비합니다. 실제 서버를 띄우거나 클라우드에 무언가를 만들지 않습니다. `pnpm dev:seed`는 로컬 시험용 사용자 정보를 `.raibitserver-work/seed.json`에 만들고, `pnpm e2e:dry`는 프로젝트 생성부터 manifest 계획까지 외부 부작용 없이 검사합니다.

검사가 끝나면 결과는 `.raibitserver-work/e2e-report.json`에서 볼 수 있습니다. 로컬 작업 상태를 정리하려면 다음 명령을 사용합니다.

```sh
pnpm dev:down
```

### 개발 화면 실행하기

API와 Dashboard를 직접 보고 싶다면 두 터미널을 사용합니다. 첫 번째 터미널에서 API를 실행합니다.

```sh
pnpm --filter @raibitserver/api dev
```

두 번째 터미널에서는 Dashboard가 API와 다른 포트를 사용하도록 실행합니다.

```sh
pnpm --filter @raibitserver/dashboard exec next dev -p 3001
```

브라우저에서 `http://localhost:3001`을 엽니다. Dashboard는 기본적으로 `http://localhost:3000/api`의 API를 사용합니다. 주소가 다르면 Dashboard를 실행하기 전에 `RAIBITSERVER_API_URL`을 설정하세요.

## 3. 가입과 관리자 승인

사용자는 로그인 화면에서 이름, 학번, 이메일, 비밀번호를 입력하고 이메일 인증을 완료합니다. 인증된 새 사용자는 바로 무제한으로 배포할 수 있는 계정이 아니라 승인 대기 상태로 시작합니다. 관리자는 **가입 신청 확인** 화면에서 신청자의 이름, 학번, 이메일, 동아리원 신청 여부를 확인한 뒤 `클럽 회원` 또는 `일반 사용자`로 승인합니다.

운영 환경의 첫 관리자는 단순히 “처음 가입한 사람”으로 정해지지 않습니다. `ADMIN_EMAILS`에 허용된 이메일과 `RAIBITSERVER_ADMIN_BOOTSTRAP_TOKEN`을 함께 사용해야 합니다. 이 값은 저장소나 화면에 적지 말고 서버의 secret manager에서 주입하세요.

관리자는 같은 화면의 **사용자 이용 제한**에서 사용자를 영구 또는 지정 시각까지 밴할 수 있습니다. 밴 사유는 감사 기록에 남고, 밴이 적용되는 순간 기존 로그인 세션도 무효화됩니다. 만료 시각이 지나면 일반 로그인과 작업 권한이 다시 허용되며, 관리자는 필요할 때 즉시 밴을 해제할 수 있습니다. 자기 자신을 밴하는 요청은 차단됩니다.

## 4. 첫 프로젝트 만들기

프로젝트 목록에서 **프로젝트 만들기**를 누르면 네 단계가 순서대로 나타납니다. `다음` 버튼은 화면만 이동하며, 프로젝트는 마지막 4단계에서 **프로젝트 만들기**를 눌렀을 때 한 번만 생성됩니다. 키보드 Enter를 눌러도 1~3단계에서는 다음 단계로 이동할 뿐 조기 생성되지 않습니다.

### 1단계: 프로젝트

사람이 알아보기 쉬운 이름을 입력합니다. 슬러그는 URL과 내부 식별에 쓰는 짧은 이름입니다. 비워 두면 서버가 이름을 기준으로 안전한 값을 만들 수 있습니다. 조직은 로그인 권한으로 서버가 확인하므로 다른 조직 ID를 직접 입력할 필요가 없습니다.

### 2단계: 저장소

일반적인 경우 `GitHub / Git 저장소`를 선택하고 저장소 URL과 브랜치만 입력합니다. 이미 빌드된 컨테이너가 있다면 `빌드된 이미지`를 선택할 수 있습니다. 로컬 Dockerfile 방식은 개발 검증용이며 production tenant API에서는 기본적으로 허용되지 않습니다.

### 3단계: 서비스

첫 서비스의 이름과 유형을 선택합니다. 보통 웹사이트나 API는 `web`, 내부 통신 전용 서버는 `private`, 큐 작업은 `worker`, 예약 실행은 `cron`, 한 번 실행하고 끝나는 작업은 `job`입니다.

Dockerfile 경로와 빌드 컨텍스트는 대부분 비워 두거나 기본값 `.`을 사용해도 됩니다. 저장소에 Dockerfile이 있으면 사용자 Dockerfile을 가장 먼저 사용합니다.

### 4단계: 리소스

필요한 데이터베이스와 캐시를 선택합니다. 지금 필요하지 않다면 `추가 안 함`을 선택해도 되고, 프로젝트를 만든 뒤 **리소스** 화면에서 추가할 수 있습니다. 이 단계를 확인한 뒤 마지막 **프로젝트 만들기** 버튼을 누르면 프로젝트, 첫 서비스, 선택한 리소스가 하나의 요청으로 생성됩니다.

## 5. 파일과 프레임워크 자동 인식

사용자가 매번 설치 명령과 시작 명령을 적지 않도록 소스 탐색기가 저장소 파일을 결정적으로 검사합니다. 우선순위는 다음과 같습니다.

1. 저장소에 사용자가 작성한 Dockerfile이 있으면 그것을 사용합니다.
2. Dockerfile이 없으면 package manifest와 프레임워크 파일을 검사합니다.
3. lockfile에 맞춰 npm, pnpm, Yarn, Bun의 고정 설치 명령을 선택합니다.
4. 실행 가능한 프레임워크를 찾으면 빌드·시작 명령과 기본 출력 경로를 계획합니다.
5. 확실한 판단을 할 수 없으면 추측해서 위험한 명령을 실행하지 않고 사용자의 설정을 기다립니다.

현재 탐색기는 Node.js 계열 프레임워크와 Nuxt, SvelteKit, Astro, Python의 Django/Flask, Java Spring 계열의 대표 파일을 인식합니다. monorepo에서는 선택한 root directory 안의 파일을 기준으로 판단하며, `..`나 절대 경로로 소스 경계를 벗어나는 설정을 거부합니다.

`.env.example`은 값이 아니라 **필요한 키 이름**을 찾는 데만 사용합니다. 실제 `.env`, `.git`, `node_modules`는 탐색 대상에서 제외되므로 로컬 비밀값이 자동 탐색 결과에 섞이지 않습니다.

자동 감지가 맞지 않을 때만 서비스 **설정** 화면에서 root directory, Dockerfile 경로, 설치·빌드·시작 명령, 출력 경로, 포트를 직접 지정하세요.

## 6. 환경 변수와 비밀키 관리

프로젝트의 **환경 변수** 탭을 열고 먼저 값을 연결할 서비스를 선택합니다. 일반 설정은 일반값으로, API token·password·secret 같은 민감한 값은 **비밀값으로 암호화하여 저장**을 선택해 저장합니다. 비밀값은 저장 후 목록과 API 응답에서 원문 대신 마스킹된 형태로 표시됩니다.

여러 값을 한 번에 옮길 때는 **.env 텍스트 가져오기**에 다음처럼 붙여 넣습니다.

```dotenv
NODE_ENV=production
PUBLIC_API_URL=https://api.example.com
DATABASE_URL=postgresql://user:password@host/database
API_TOKEN=replace-with-real-token
```

키 이름이 token, password, secret 등으로 보이면 비밀값으로 자동 분류됩니다. 그래도 저장하기 전에 분류가 맞는지 확인하세요. 저장된 비밀값을 수정할 때는 기존 원문을 다시 보여 주지 않으며 새 값을 입력해 교체합니다.

다음 원칙을 지키면 실수를 크게 줄일 수 있습니다.

- 실제 `.env` 파일을 Git에 commit하지 않습니다.
- 예제 파일에는 `API_TOKEN=`처럼 키 이름만 둡니다.
- 서비스 코드에는 비밀값을 직접 적지 않고 환경 변수로 읽습니다.
- 로그에 전체 token이나 connection string을 출력하지 않습니다.
- 운영용 플랫폼 secret은 tenant 환경 변수 화면이 아니라 Kubernetes Secret 또는 외부 secret manager에서 관리합니다.

## 7. 데이터베이스와 관리형 리소스

프로젝트의 **리소스** 탭에서 PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, SQLite, Object Storage, Qdrant, NATS 등을 추가할 수 있습니다. 리소스는 docker-compose의 임의 컨테이너가 아니라 플랫폼 카탈로그 항목입니다. API가 원하는 상태를 저장하면 provisioner가 실제 provider 상태를 맞춥니다.

리소스가 준비되면 공개 가능한 endpoint 정보와 Secret reference를 서비스에 연결합니다. 자격 증명 원문은 control-plane DB나 일반 로그에 복사하지 않는 것이 기본 계약입니다. DB console의 읽기, 데이터 조회, 쓰기 권한도 서로 분리되어 있으므로 화면이 보인다고 모든 쿼리를 실행할 수 있는 것은 아닙니다.

처음에는 작은 개발용 리소스로 시작하고, production으로 옮기기 전에 백업, 보존 기간, 용량 제한, 복구 절차를 확인하세요. 현재 provider별 실제 지원 범위와 제한은 [리소스 프로비저닝 문서](provisioning.md)에 정리되어 있습니다.

## 8. AI 배포 관리자 사용하기

프로젝트의 **AI 배포** 탭을 열면 모든 서비스를 다시 읽어 배포 계획을 만듭니다. 외부 AI를 설정하지 않아도 내장된 결정적 검사만으로 동작합니다. 검사 항목에는 다음이 포함됩니다.

- privileged, root, hostPath, hostNetwork 같은 위험한 workload 설정
- digest로 고정되지 않은 컨테이너 이미지
- 자격 증명이 포함되었거나 안전하지 않은 저장소 URL
- 원격 스크립트 실행, 광범위 삭제, sudo, 777 권한 같은 위험 명령
- Secret reference 대신 평문으로 들어간 비밀키 모양의 환경 변수

critical 또는 high 위험이 하나라도 있으면 전체 자동 배포가 차단됩니다. 화면에서 서비스별 위협 코드와 설명을 확인하고 서비스 설정 또는 환경 변수를 수정한 뒤 계획을 다시 여세요.

검사를 통과하면 **검증된 계획 실행** 버튼으로 여러 서비스를 순서대로 운영 배포 대기열에 넣을 수 있습니다. 실행 직전에 서버가 현재 설정을 다시 읽어 같은 보안 검사를 수행하므로, 계획 화면을 본 뒤 누군가 위험한 설정으로 바꿨다면 배포하지 않습니다.

외부 AI가 배포 순서를 제안하게 하려면 API 서버에 다음 값을 설정합니다.

```dotenv
RAIBITSERVER_AI_AGENT_URL=https://ai-gateway.example.com/v1/deployment-plan
RAIBITSERVER_AI_AGENT_TOKEN=replace-with-server-side-token
RAIBITSERVER_AI_AGENT_MODEL=your-approved-model
```

외부 AI에는 프로젝트 ID·이름, 서비스 ID·이름·유형, 배포 가능 여부와 위협 코드만 전달합니다. 환경 변수 값, 저장소 자격 증명, token은 보내지 않습니다. 응답 크기와 시간이 제한되며 HTTPS 또는 loopback 주소만 허용합니다. 외부 AI가 실패하거나 잘못된 서비스 ID를 반환하면 안전한 내장 계획으로 돌아갑니다. 외부 AI는 순서를 제안할 뿐 보안 차단을 해제할 수 없습니다.

## 9. 수동 배포, 상태와 로그

한 서비스만 직접 배포하려면 **서비스** 탭에서 `운영 배포` 또는 `미리보기`를 선택합니다. 데스크톱에서는 두 버튼이 한 줄의 36px 높이로 표시되고, 터치 화면에서는 누르기 쉽도록 44px 높이가 됩니다.

운영 배포는 실제 운영 URL을 갱신하는 용도입니다. 미리보기 배포는 PR이나 변경 내용을 별도 주소로 확인하는 용도입니다. 요청을 보낸 뒤 **배포** 탭에서 상태를 열고 build log, deployment event, image digest를 확인하세요. 서비스 실행 중 문제는 **로그** 탭에서 확인합니다.

실패했을 때는 다음 순서가 가장 빠릅니다.

1. 빌드 로그에서 의존성 설치나 Dockerfile 오류를 찾습니다.
2. 서비스 설정의 root directory와 Dockerfile 경로를 확인합니다.
3. 필요한 환경 변수 키가 빠지지 않았는지 확인합니다.
4. 이미지가 production 정책에 맞게 digest로 고정되었는지 확인합니다.
5. 쿼터 또는 보안 정책이 배포를 차단했는지 deployment event를 확인합니다.

## 10. GitHub 연결과 자동 미리보기

상단의 **저장소 연결**에서 GitHub App을 설치하고 허용할 저장소만 선택합니다. 저장소를 프로젝트 서비스에 연결하면 push와 pull request webhook을 검증해 배포 workflow를 만들 수 있습니다. webhook secret이 없거나 HMAC이 맞지 않는 요청은 거부됩니다.

PR 미리보기 주소는 base domain 바로 아래의 단일 label을 사용합니다.

```text
preview--pr-<번호>--<사용자>--<프로젝트>.raibitserver.app
```

PR이 닫히면 해당 preview를 정리하는 workflow가 생성됩니다. GitHub App의 최소 권한과 callback/webhook 설정은 [GitHub App 가이드](github-app.md), preview 수명 주기는 [Preview Deployment 가이드](preview-deployments.md)를 참고하세요.

## 11. 서버가 main의 최신 버전을 자동 사용하게 만들기

production 서버에는 `deploy/production/auto-update.sh`와 `install-auto-update.sh`를 한 번 설치할 수 있습니다. updater는 약 5분마다 GitHub `main`의 새 SHA를 확인하지만, 새 commit이 있다는 이유만으로 바로 배포하지 않습니다. 그 정확한 SHA의 push CI가 완료되고 성공한 경우에만 별도 checkout에서 이미지를 빌드합니다.

자체 workload registry를 사용한다면 installer보다 먼저 서버 사용자로 registry bootstrap을 실행합니다. 이 단계는 registry와 broker를 만들고, cluster 내부 split DNS가 공개 registry hostname을 전용 TLS gateway Service로 보내도록 설정합니다. 함께 생성되는 `~/.config/raibitserver/workload-registry-values.yaml`은 executor가 `raibitserver-infra`의 정확한 broker Pod와 Service 443/target 8443에만 연결하도록 합니다. 공유 Ingress나 사설 IP 대역 전체는 열지 않습니다.

```sh
bash deploy/production/bootstrap-workload-registry.sh
```

설치 전에 서버에 Docker/buildx, Git, GitHub CLI, Cosign, Helm, kubectl, Python 3, production kubeconfig와 values 파일을 준비합니다. registry login과 Cosign signing key도 서버에 있어야 합니다. 준비가 끝난 뒤 저장소 checkout에서 서버 사용자 이름을 넣어 실행합니다.

```sh
sudo bash deploy/production/install-auto-update.sh raibit1
```

설치 후 상태는 다음 명령으로 봅니다.

```sh
systemctl status raibitserver-auto-update.timer
systemctl status raibitserver-auto-update.service
journalctl -u raibitserver-auto-update.service -f
```

updater는 platform 이미지 7개를 build/push하고 digest를 확인한 뒤 Cosign으로 서명합니다. workload registry overlay가 있으면 파일 소유권과 쓰기 권한을 검사하고 immutable snapshot으로 복사한 뒤 lint, template, upgrade에 동일하게 넣습니다. Helm 3에서는 `--atomic`, Helm 4에서는 `--rollback-on-failure`와 watcher wait를 사용합니다. API와 Dashboard rollout이 모두 성공해야 배포 SHA를 기록하며, 실패하면 현재 정상 release와 이전 성공 SHA를 유지합니다. updater 자체도 성공한 checkout의 파일로 원자적으로 교체됩니다.

자동 업데이트를 잠시 멈추거나 다시 시작할 때는 timer만 제어합니다.

```sh
sudo systemctl disable --now raibitserver-auto-update.timer
sudo systemctl enable --now raibitserver-auto-update.timer
```

values 파일, kubeconfig, registry credential, signing key는 GitHub 저장소나 updater의 일반 설정 파일에 복사하지 않습니다. 더 자세한 준비물과 상태 파일 위치는 [Production 자동 업데이트 문서](../deploy/production/README.md#main-자동-production-업데이트)를 확인하세요.

## 12. 운영 전 확인표

기능이 화면에서 보이는 것과 production에 안전하게 올릴 준비가 된 것은 다릅니다. 실제 사용자에게 열기 전에 다음을 확인하세요.

- PostgreSQL persistence와 Prisma migration을 적용했습니다.
- JWT secret과 secret encryption key를 서버 secret manager에서 주입했습니다.
- 첫 admin bootstrap 범위를 제한했습니다.
- 사용자 workload namespace, NetworkPolicy, non-root, resource limit 정책이 켜져 있습니다.
- platform 이미지와 provider 이미지를 sha256 digest로 고정했습니다.
- registry와 Cosign signing credential을 서버에만 보관합니다.
- GitHub webhook HMAC 검증을 설정했습니다.
- DB, Redis, registry, Kubernetes API를 public internet에 직접 열지 않았습니다.
- 백업과 restore 리허설, audit log 보관, 실패 알림을 준비했습니다.
- 아래 검증 명령이 통과했습니다.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm prisma:validate
node scripts/check-structure.js
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json
node src/cli.js compose examples/docker-compose.yml
```

Go가 설치된 환경이라면 `services/builder`, `orchestrator`, `provisioner`, `log-ingester`, `metrics-ingester`에서도 `go test ./...`와 `go build ./...`를 실행하세요.

## 13. 자주 막히는 지점

### `pnpm install`이 실패합니다

`node --version`이 24 이상인지, `pnpm --version`이 11.1.2인지 확인합니다. 다른 pnpm 버전을 전역 설치했다면 Corepack을 다시 활성화하세요.

### 3단계에서 프로젝트가 바로 만들어집니다

최신 Dashboard에서는 1~3단계의 버튼과 Enter 입력이 폼을 제출하지 않습니다. 브라우저에 예전 JavaScript bundle이 남아 있을 수 있으므로 Dashboard를 다시 build/deploy하고 캐시를 비운 뒤 확인하세요. 최신 화면은 `4 / 4`에서만 **프로젝트 만들기** 버튼을 표시합니다.

### AI 배포 버튼이 비활성입니다

치명적 또는 높은 위험이 있거나 배포 가능한 서비스가 없는 상태입니다. 서비스별 위협 코드부터 확인하세요. 특히 평문 secret, digest가 없는 이미지, 위험 명령이 자주 원인입니다.

### 환경 변수 값이 점으로만 보입니다

비밀값은 정상적으로 마스킹된 것입니다. 기존 값을 다시 표시하지 않으므로 변경하려면 새 값을 입력해 교체합니다.

### 자동 업데이트가 새 commit을 반영하지 않습니다

해당 SHA의 push CI가 성공했는지 먼저 확인합니다. 이어서 systemd service log, registry login, Cosign key, values 파일 권한, Helm major version, Kubernetes rollout 상태를 확인하세요. 실패한 SHA를 강제로 성공 처리하지 않는 것이 정상 동작입니다.

더 많은 오류 코드와 진단 순서는 [문제 해결 문서](troubleshooting.md)를 참고하세요.

## 다음에 읽을 문서

- 구조가 궁금하면 [아키텍처](architecture.md)
- production 설치를 준비하면 [Production 배포](../deploy/production/README.md)
- 보안 경계를 검토하면 [보안 정책](security.md)
- 실제 클러스터 smoke test가 필요하면 [Live E2E](live-e2e.md)
- API를 직접 연결하면 [OpenAPI 계약](../openapi/raibitserver.yaml)
