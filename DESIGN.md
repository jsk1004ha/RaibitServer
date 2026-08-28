# RAIBITSERVER Dashboard Design System

## Source of truth

- Status: Active
- Last refreshed: 2026-08-27
- Primary product surfaces: 공개 홈페이지, 인증, 프로젝트 콘솔, GitHub 저장소 연결, 배포 상세, 리소스 콘솔, 관리자 승인
- Evidence reviewed: `apps/dashboard/app/**`, `apps/dashboard/components/**`, `apps/dashboard/app/globals.css`, `output/playwright/review/**`, `packages/core/src/manifest-compiler.ts`, `services/orchestrator/internal/kube/deployment.go`, 사용자 검토 의견, Vercel Projects·Storage 문서, Vercel Geist 디자인 시스템

## Brand

- Personality: Vercel처럼 정돈되고 빠르지만 초보자도 바로 이해하는 운영 도구
- Trust signals: 라이빗 로고, 명시적 상태, 권한 경계, 마스킹된 보안 정보, 확인 가능한 단계
- Avoid: 한 화면에 여러 폼 배치, 중첩 카드, 장식 목적의 과도한 효과, 내부 API 용어, 콘솔 안의 긴 사용 설명

## Product goals

- Goals: 사용자가 현재 해야 할 한 가지 행동을 바로 이해하고, 생성·연결·운영 작업을 실수 없이 완료하게 한다.
- Non-goals: 모든 운영 정보를 한 화면에서 동시에 보여주는 고밀도 모니터링 대시보드
- Success signals: 각 URL 또는 단계에 주 활동이 하나만 있고, 다음·이전 이동이 분명하며 모바일에서 가로 겹침이 없다.

## Personas and jobs

- Primary personas: 인천과학고 라이빗 동아리원, 비동아리 사용자, 관리자
- User jobs: 프로젝트 생성, 저장소 연결, 서비스·배포·리소스 상태 확인, 관리자 가입 승인
- Key contexts of use: 학교 PC와 개인 노트북, 모바일에서 빠른 상태 확인

## Information architecture

- Primary navigation: 공개 홈페이지 → 로그인 → 콘솔 → 프로젝트 → 서비스·배포·리소스별 하위 화면. 고정 상단 바는 검색과 사용 설명서만 제공한다.
- Core routes/screens: 홈페이지, 운영 사이트 현황, 프로젝트 생성 단계, GitHub 연결 단계, 프로젝트 개요·서비스·배포·리소스·설정, 배포 개요·로그·이벤트·상태·롤백·취소, 리소스 개요·스키마·쿼리·공급자·백업·연결·프로비저닝
- Content hierarchy: 페이지 제목 → 현재 단계/하위 화면 → 단일 주 활동 → 다음 이동

## Design principles

- Principle 1: 한 화면에는 하나의 정보 주제 또는 하나의 사용자 활동만 둔다.
- Principle 2: 생성과 외부 연결은 번호가 있는 순차 단계로 진행하며 현재·완료·다음 단계를 구분한다.
- Principle 3: Vercel의 얇은 탭·행·구분선 중심 배치를 사용하고, 초보자에게 필요한 핵심 행동부터 보여준다.
- Density rule: 한 주제 안에서는 조밀하게, 서로 다른 주제는 별도 화면으로 분리한다.
- Surface rule: 목록·지표·상세는 평면과 구분선을 사용하고, 카드형 작업면은 폼·위험 확인·모달에만 사용한다.
- Tradeoffs: 고급 기능은 한 단계 더 들어가지만 첫 화면의 인지 부하와 실수 가능성을 낮춘다.

## Visual language

- Color: 기존 차콜·네이비와 녹색 핵심 행동 조합 유지
- Typography: 페이지 제목 28px(모바일 24px), 섹션 18px, 본문·목록·버튼 13–14px, 보조 정보 최소 11–12px
- Spacing/layout rhythm: 4px 단위, 얇은 탭과 행 중심, 생성 흐름은 최대 1120px의 넓은 작업 카드, 현황 화면은 실제 운영 정보로 밀도를 확보
- Shape/radius/elevation: 기존 입력 8–9px, 패널 12–13px, 얕은 그림자 유지. 오류 화면은 예외적으로 카드·테두리·그림자 없이 전체 viewport를 하나의 상태 면으로 사용한다.
- Motion: 단계 전환 120–180ms, `prefers-reduced-motion` 준수
- Imagery/iconography: 라이빗 로고와 기존 타입 안전 Heroicons 재사용

## Components

- Existing components to reuse: `ConsoleShell`, `StatusBadge`, `MetricStrip`, `LogViewer`, `JsonCard`, `Icon`
- New/changed components: 얇은 탭형 `SectionNav`, 단계형 `SectionNav`, 데스크톱에서 최대 1080×760px 작업면을 제공하는 `ConsoleSearch`, 검색·사용 설명서 전용 고정 상단 바, `console-surface`, `form-surface`, 프로젝트 생성 단계, 주제별 사용 안내, 공개·호스팅 공용 `ErrorScreen`
- Variants and states: 활성 단계, 완료 단계, 비활성 단계, 빈 상태, 준비 중, 위험 작업
- Token/component ownership: 전역 토큰은 `globals.css`, 흐름 컴포넌트는 `apps/dashboard/components`

## Accessibility

- Target standard: WCAG 2.1 AA
- Keyboard/focus behavior: 단계와 하위 화면 링크를 순서대로 탐색하고 현재 항목에 `aria-current` 제공. 메뉴 검색은 `Ctrl/⌘ + K` 또는 `/`로 열고 `Esc`로 닫으며 포커스를 복귀한다. 현재 프로젝트에서는 현황·서비스·배포·리소스·로그·설정을 검색할 수 있다. 검색 입력과 검색 버튼은 녹색 윤곽 대신 중립 구분선과 커서로 포커스를 알린다.
- Contrast/readability: 기존 의미 색상과 텍스트 레이블 병행
- Screen-reader semantics: 단계는 `ol`, 하위 화면은 `nav`, 폼은 명시적 레이블과 제목 사용
- Reduced motion and sensory considerations: 반짝임·단계 전환은 감소 모션 설정에서 정지

## Responsive behavior

- Supported breakpoints/devices: 1440px 데스크톱, 900px 이하 태블릿·모바일, 390px 모바일 검토
- Layout adaptations: 단계와 하위 화면 탭은 가로 스크롤, 주 활동 패널은 단일 열, 사이드바는 모바일에서 숨기고 상단 검색 팔레트로 메뉴 이동. 오류 화면은 데스크톱에서 큰 상태 코드와 설명을 좌우 분할하고, 모바일에서는 코드 → 설명 → 세부 정보 → 전체 너비 행동 순서의 전용 세로 레이아웃으로 재배치한다.
- Touch/hover differences: 모바일 버튼 최소 높이 44px, hover 없이도 현재 단계와 상태를 텍스트로 식별

## Interaction states

- Loading: 패널 크기를 유지하는 스켈레톤
- Empty: 원인과 다음 행동 하나
- Error: 상태 코드, 한국어 요약, 가능한 원인, 재시도 또는 안전한 이전 단계, 노출 가능한 기술 식별자
- Success: 완료 상태와 다음 단계 링크
- Disabled: 선행 조건과 비활성 이유를 인접 문구로 표시
- Offline/slow network, if applicable: 마지막 확인 상태와 재시도 행동 표시

## Content voice

- Tone: 짧고 직접적인 한국어 안내
- Terminology: 저장소, 프로젝트, 서비스, 배포, 리소스를 일관되게 사용
- Microcopy rules: 콘솔 설명은 한 줄·몇 단어, 버튼은 행동형, 핵심 버튼 하나만 녹색 채움, 자세한 설명은 `/guide`로 이동
- Metrics rule: 단순 개수에는 막대를 표시하지 않는다. 비율 시각화는 실제 분모와 진행률이 있을 때만 사용한다.
- Button rule: 기본 36px, 모바일 44px. 녹색 primary는 화면당 하나, 위험 작업은 danger, 취소·탐색은 neutral/ghost.

## Implementation constraints

- Framework/styling system: Next.js 서버 컴포넌트 중심, 단계 입력 유지가 필요한 곳만 클라이언트 컴포넌트 사용, 기존 CSS
- Design-token constraints: 현재 색 조합과 전역 토큰 유지
- Performance constraints: 화면별 필요한 데이터만 장기적으로 분리하되 이번 변경은 기존 API 계약을 보존
- Compatibility constraints: 새 의존성 금지, 기존 API 경로·권한·폼 필드 유지
- Test/screenshot expectations: 타입 검사, 대시보드 테스트, 프로덕션 빌드, 데스크톱·모바일 실제 화면 캡처

## Open questions

- [ ] 실제 운영 데이터 규모가 커질 때 목록 화면의 검색·페이지네이션 기준 / 운영자 / 중간
- [ ] 단계형 폼 임시 저장을 서버 세션까지 확장할지 여부 / 제품 담당 / 낮음
- [x] 프로젝트 생성 레이아웃은 A 넓은 카드형으로 확정 / 사용자 검토 / 완료
- [x] 프로젝트 현황 레이아웃은 A 조밀 요약형으로 확정 / 사용자 검토 / 완료
- [x] Vercel 기반 초보자용 콘솔 방향을 평면 행·단일 작업면·명령 팔레트로 확정 / 사용자 요청 / 완료

## 1. 목적

RAIBITSERVER 대시보드는 클럽, 학교, 소규모 팀이 프로젝트·배포·관리형 리소스를 빠르게 이해하고 안전하게 운영할 수 있는 한국어 우선 관리 콘솔이다. 기존 제어 영역 API, 라우팅, 폼 액션, 권한 및 감사 동작은 유지하고 표현 계층만 재구성한다.

시각 방향은 제공된 Stitch 관리 대시보드의 정밀한 인프라 콘솔 구조를 기반으로 하며, ASTRYX의 넓고 명확한 계층, 모듈형 컴포넌트, 절제된 주변광을 결합한다. 결과물은 장식적인 마케팅 화면이 아니라 높은 정보 밀도와 긴 모니터링 세션에 적합한 운영 도구여야 한다.

## 2. 핵심 원칙

1. **한국어 우선**: 사용자에게 노출되는 제목, 설명, 버튼, 상태, 빈 화면, 오류 메시지는 한국어로 작성한다.
2. **운영 정보 우선**: 상태, 다음 행동, 실패 원인, 영향을 받는 리소스를 장식보다 먼저 보여준다.
3. **조밀하지만 답답하지 않게**: 큰 빈 공간과 중첩 카드를 피하고 4px 기반 간격으로 관련 정보를 묶는다.
4. **가로 흐름 유지**: KPI와 주요 작업은 낮은 가로 스트립으로 표현한다. 좁은 세로 카드를 반복하지 않는다.
5. **기존 동작 보존**: API 경로, 서버 렌더링, 폼 전송, 데이터 계약, 테스트 표식은 시각 개편 때문에 변경하지 않는다.
6. **새 의존성 금지**: UI 프레임워크나 아이콘 패키지를 추가하지 않는다.
7. **접근성 기본 제공**: 키보드 탐색, 명확한 포커스, 색상 외 상태 표식, 충분한 대비를 기본값으로 한다.

## 3. 브랜드 성격

- 신뢰할 수 있는 운영 도구
- 기술적이되 난해하지 않은 인터페이스
- 빠르고 정밀한 제어
- 과장되지 않은 프리미엄 품질

색상과 표면은 어두운 차콜·네이비 계열을 사용한다. 녹색은 정상 상태와 핵심 행동, 파란색은 정보와 진행 상태, 황색은 주의, 붉은색은 실패와 파괴적 행동에만 사용한다.

## 4. 디자인 토큰

### 4.1 색상

| 토큰 | 값 | 용도 |
| --- | --- | --- |
| `--color-canvas` | `#0b0e12` | 앱 배경 |
| `--color-rail` | `#0e1217` | 사이드바 |
| `--color-surface` | `#151a20` | 기본 패널 |
| `--color-surface-raised` | `#1b2128` | 입력, 버튼, 활성 행 |
| `--color-surface-strong` | `#222932` | 선택 상태 |
| `--color-border` | `#2b333c` | 기본 구분선 |
| `--color-text` | `#eef2f6` | 주요 텍스트 |
| `--color-text-soft` | `#aeb7c0` | 보조 텍스트 |
| `--color-text-muted` | `#87929e` | 메타데이터 |
| `--color-primary` | `#68df88` | 핵심 행동, 정상 상태 |
| `--color-primary-ink` | `#08250f` | 녹색 표면 위 텍스트 |
| `--color-info` | `#64b9ee` | 정보, 진행률 |
| `--color-warning` | `#e8ad4a` | 경고, 대기 |
| `--color-danger` | `#ff857d` | 실패, 파괴적 행동 |

전체 화면에는 낮은 불투명도의 파란색 또는 녹색 방사형 주변광을 최대 두 개까지만 사용할 수 있다. 데이터 패널 내부에는 장식용 그라데이션을 사용하지 않는다.

### 4.2 타이포그래피

- 인터페이스: `"Noto Sans KR", Inter, system-ui, sans-serif`
- 로그·식별자·수치: `"JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace`
- 페이지 제목: 27–34px, 700, 자간 `-0.035em`
- 패널 제목: 14–16px, 650–700
- 본문: 13–14px, 400–500
- 레이블: 10–11px, 600
- 기술 메타데이터: 10–11px 모노스페이스, `font-variant-numeric: tabular-nums`

외부 폰트 다운로드에 의존하지 않는다. 시스템에 첫 번째 글꼴이 없으면 다음 글꼴로 자연스럽게 대체한다.

### 4.3 간격과 크기

4px를 기본 단위로 사용한다.

| 항목 | 데스크톱 | 태블릿·모바일 |
| --- | --- | --- |
| 페이지 좌우 여백 | 24–28px | 16–20px |
| 패널 내부 여백 | 12–16px | 12–14px |
| 패널 간격 | 12px | 10–12px |
| 사이드바 폭 | 238px | 상단 탐색으로 전환 |
| 상단바 높이 | 58px | 54–58px |
| KPI 스트립 높이 | 78–84px | 가로 스크롤 유지 |
| 빠른 작업 높이 | 46–56px | 44–52px |
| 테이블 행 높이 | 52–56px | 48–52px |
| 입력 높이 | 36–40px | 40px |

### 4.4 모서리와 테두리

- 입력·작은 버튼: 8–9px
- 빠른 작업·내부 셀: 10px
- 일반 패널: 12–13px
- 앱 프레임·대형 콘솔: 16–18px
- 상태 배지: 999px
- 기본 테두리: 1px `--color-border`

패널 안에 같은 크기의 테두리 패널을 반복하지 않는다. KPI 스트립은 하나의 외부 컨테이너와 얇은 세로 구분선만 사용한다.

## 5. 아이콘

아이콘은 [Heroicons](https://heroicons.com/)의 공식 `optimized/24/outline` SVG를 사용한다.

- 원본 SVG의 전체 `path`를 변경하거나 축약하지 않는다.
- 기본 크기는 18px, `viewBox="0 0 24 24"`, `stroke-width="1.5"`이다.
- 색상은 `currentColor`를 사용한다.
- 장식 아이콘은 `aria-hidden="true"`로 숨긴다.
- 아이콘만 있는 버튼은 한국어 `aria-label`을 제공한다.
- 의미가 같은 아이콘을 화면마다 다르게 사용하지 않는다.
- 프로젝트 코드에서는 허용된 아이콘 이름과 전체 경로를 한 곳에서 관리하는 타입 안전한 `Icon` 컴포넌트를 사용한다.

주요 매핑:

| 기능 | Heroicons 이름 |
| --- | --- |
| 개요 | `squares-2x2` |
| 프로젝트 | `folder` |
| 배포 | `rocket-launch` |
| 리소스 | `circle-stack` |
| 콘솔·로그 | `command-line` |
| 설정 | `cog-6-tooth` |
| 검색 | `magnifying-glass` |
| 알림 | `bell` |
| 추가 | `plus` |
| 서버·브랜드 보조 표식 | `server-stack` |

## 6. 공통 레이아웃

### 6.1 데스크톱: 1180px 초과

- 238px 고정 사이드바와 유동형 본문을 사용한다.
- 상단바는 본문 상단에 고정하고 반투명 배경과 14px 블러를 적용한다.
- 본문은 주 콘텐츠와 278–320px 보조 패널로 나눌 수 있다.
- 검색, 알림, 계정, 현재 워크스페이스를 모든 관리 화면에서 같은 위치에 둔다.

### 6.2 태블릿: 900–1180px

- 주 콘텐츠가 좁아지기 전에 보조 패널을 본문 아래로 옮긴다.
- 빠른 작업은 한 줄 또는 2열의 낮은 버튼으로 재배치한다.
- KPI는 단일 가로 스트립을 유지한다.

### 6.3 모바일: 900px 미만

- 사이드바를 상단 탐색과 메뉴 서랍으로 전환한다.
- KPI를 세로 카드로 쌓지 않고 가로 스크롤 가능한 스트립으로 제공한다.
- 테이블은 핵심 열만 유지하고 나머지는 행 상세 화면에서 보여준다.
- 터미널과 데이터 테이블은 가로 스크롤을 허용하되 페이지 전체가 흔들리지 않게 컨테이너 안에서 처리한다.

## 7. 공통 컴포넌트

### 7.1 `ConsoleShell`

브랜드, 워크스페이스 선택기, 사이드바, 상단 검색, 알림, 계정, 모바일 탐색을 제공한다. 현재 경로에 따라 활성 메뉴와 페이지 제목을 결정하며 콘텐츠 데이터는 소유하지 않는다.

### 7.2 `Icon`

허용된 Heroicons 이름만 입력받아 공식 SVG 전체 경로를 렌더링한다. 크기, 접근성 레이블, 장식 여부를 명시할 수 있다.

### 7.3 `StatusBadge`

상태 점, 한국어 레이블, 의미 색상을 함께 표시한다. 색상만으로 상태를 표현하지 않는다.

- 정상·실행 중·승인: 녹색
- 빌드·대기·프로비저닝: 황색 또는 파란색
- 실패·차단·오프라인: 붉은색
- 알 수 없음: 중립 회색

### 7.4 `MetricStrip`

하나의 패널 안에 KPI를 가로로 배열한다. 각 항목은 한 줄 레이블, 탭형 숫자, 짧은 변화량 또는 미터를 가진다. 내부 카드를 만들지 않으며 항목 사이에는 구분선만 둔다.

### 7.5 `DataPanel`

제목, 선택적 Heroicon, 보조 행동, 콘텐츠를 제공하는 기본 패널이다. 페이지가 임의의 카드 스타일을 새로 만들지 않도록 한다.

### 7.6 `QuickAction`

아이콘과 한국어 레이블을 수평 정렬한 46–56px 버튼이다. 핵심 행동 하나만 녹색 채움으로 강조하고 나머지는 중립 표면을 사용한다.

### 7.7 `DataTable`

검색·필터·상태·행 작업·빈 화면을 일관되게 제공한다. 데스크톱 행 높이는 52–56px이며 수치 열은 모노스페이스로 우측 정렬한다.

### 7.8 `LogViewer`

시간, 수준, 메시지를 모노스페이스 3열로 표시한다. 로그 원문은 번역하지 않으며 비밀처럼 보이는 값은 기존 마스킹 규칙을 따른다.

### 7.9 `EmptyState`와 `ErrorState`

빈 화면은 이유와 다음 행동 하나를 함께 제공한다. 오류 화면은 사용자 친화적 한국어 설명, 기술 식별자, 재시도 또는 안전한 복구 행동을 포함한다.

## 8. 페이지별 구성

### 8.1 홈

- 플랫폼 연결 상태
- 가로 KPI 스트립
- 프로젝트 콘솔 목록
- 빠른 작업
- 최근 활동과 런타임 로그
- 제어 영역 API·리전·버전

### 8.2 프로젝트 목록

- 프로젝트 검색과 상태 필터
- 이름, 상태, 서비스 수, 리소스 수, 최근 배포, 작업을 포함한 조밀한 테이블
- 새 프로젝트 행동
- 빈 화면에서는 GitHub 가져오기 또는 직접 생성으로 안내

### 8.3 프로젝트 생성

- 소스 유형, 저장소, 브랜치, Dockerfile, 빌드 컨텍스트를 논리적 단계로 묶는다.
- 사용자 Dockerfile 우선 원칙을 화면에 명확히 표시한다.
- 검증 오류는 해당 입력 바로 아래에 표시한다.

### 8.4 프로젝트 상세

- 개요, 서비스, 배포, 리소스, 도메인, 환경 변수, 감사, 설정 탭
- 상단 KPI 스트립
- 서비스·리소스 표
- 배포 행동과 미리보기 링크
- 위험 작업은 별도 위험 영역과 확인 문구를 사용

### 8.5 배포 상세

- 상태와 이미지 식별자
- 빌드·배포 이벤트 타임라인
- 터미널형 빌드 및 런타임 로그
- 미리보기 URL 또는 운영 URL
- 실패 원인과 재배포·롤백 행동

### 8.6 리소스 콘솔

- 리소스 상태와 연결 정보
- 스키마·데이터 브라우저·쿼리 탭
- 쿼리 편집기와 결과 테이블의 분할 패널
- 읽기·쓰기 위험도와 권한을 명확히 표시

### 8.7 GitHub 연결

- 설치 상태, 저장소 연결, 웹훅 상태, 최근 이벤트
- 연결되지 않은 상태에서는 설치 행동 하나를 강조

### 8.8 관리자

- 사용자 승인, 조직, 할당량, 사용량, 감사 이벤트
- 파괴적이거나 권한에 영향을 주는 행동은 일반 작업과 시각적으로 분리

### 8.9 로그인·가입

- 관리 콘솔과 동일한 색상·입력·버튼 체계를 사용한다.
- 제품 가치 설명은 짧게 유지하고 인증 행동을 우선한다.
- 오류는 계정 존재 여부 같은 민감 정보를 노출하지 않는다.

### 8.10 오류 화면

- 대시보드 404는 로그인 여부와 무관하게 표시하며 메인·운영 현황으로 안전하게 이동한다.
- 500 경계는 원본 예외 메시지를 숨기고 재시도와 무작위 기술 식별자만 제공한다.
- 데스크톱 오류 화면은 카드를 사용하지 않고 화면 전체를 채운다. 큰 상태 코드와 설명 영역을 분할선 하나로 구분하며 주변 여백 자체를 레이아웃으로 사용한다.
- 모바일 오류 화면은 데스크톱 축소판이나 작은 카드가 아니다. 상태 코드를 상단에 두고 제목의 줄 길이를 제한하며, 세부 정보는 읽기 쉬운 단일 열, 행동은 하단의 전체 너비 버튼으로 제공한다.
- 오류 인덱스와 호스팅 오류 backend는 IANA에 등록된 활성 4xx·5xx 38종을 같은 레이아웃과 한국어 안내로 제공한다. 4xx는 `400–417`, `421–426`, `428`, `429`, `431`, `451` 중 활성 코드 28종, 5xx는 `500–508`, `511` 중 활성 코드 10종이다.
- 미사용 `418`, 폐기된 `510`, 미등록 상태는 검증 목록에서 제외하고 안전한 404로 정규화한다.
- 플랫폼은 미매칭 tenant hostname 404와 upstream `500`, `502`, `503`, `504`를 공통 화면으로 처리한다. 사용자 애플리케이션이 직접 만든 404는 덮어쓰지 않는다.
- 호스팅 오류 문서는 외부 CSS·JavaScript 없이 렌더되어 사용자 사이트가 응답하지 않아도 독립적으로 표시된다.

## 9. 한국어 문구 규칙

- 버튼은 명사보다 행동형으로 작성한다: `프로젝트 생성`, `다시 배포`, `리소스 연결`.
- 내부 API 명칭을 사용자 제목으로 그대로 노출하지 않는다.
- Kubernetes 용어는 이벤트·진단 세부 정보에서만 사용한다.
- 상태값은 사용자 화면에서 한국어로 매핑하지만 원본 값은 데이터 속성과 로그에 유지한다.
- 식별자, URL, 브랜치, 이미지 다이제스트, 로그 메시지는 번역하지 않는다.

## 10. 상태·오류·피드백

- 로딩: 레이아웃 크기가 유지되는 스켈레톤을 사용한다.
- 빈 상태: 이유, 현재 범위, 다음 행동 하나를 제공한다.
- 성공: 짧은 인라인 메시지 또는 토스트와 갱신된 상태를 함께 보여준다.
- 오류: 상태 코드를 첫 시선에 식별할 수 있게 하고, 한국어 요약, 가능한 원인, 재시도 행동, 안전한 기술 식별자를 제공한다. 예외 원문·내부 Service/namespace·환경 변수는 표시하지 않는다.
- 긴 작업: 진행 단계와 마지막 갱신 시간을 표시한다.
- 파괴적 행동: 붉은색, 영향 범위, 확인 문구, 감사 로그 발생 여부를 표시한다.

## 11. 접근성

- 텍스트 대비는 WCAG AA를 충족한다.
- 모든 조작 요소에 `:focus-visible` 윤곽선을 제공한다.
- 44px보다 작은 아이콘 버튼은 충분한 클릭 영역을 확보한다.
- 상태는 색상, 점, 텍스트를 함께 사용한다.
- 테이블 헤더와 폼 레이블을 시맨틱 요소로 연결한다.
- 애니메이션은 120–180ms 범위로 제한하고 `prefers-reduced-motion`을 존중한다.
- 모바일 메뉴, 탭, 모달은 키보드 포커스를 올바르게 관리한다.

## 12. 구현 경계

주요 변경 대상:

- `apps/dashboard/app/globals.css`: 토큰, 공통 레이아웃, 컴포넌트 스타일, 반응형 규칙
- `apps/dashboard/components/console-ui.tsx`: 셸과 공통 컴포넌트
- `apps/dashboard/components/icon.tsx`: Heroicons SVG 매핑
- `apps/dashboard/components/project-card.tsx`: 새 패널·표 패턴 적용
- `apps/dashboard/app/**/page.tsx`: 한국어 문구와 페이지별 구성

보존 대상:

- `apps/dashboard/lib/api.ts`의 데이터 요청과 `apiAction` 계약
- 서버 컴포넌트 중심 렌더링
- 폼의 메서드와 대상 API 경로
- 테스트가 확인하는 보안·권한·감사 관련 표식
- 대시보드 외 API·CLI·Go 서비스 동작

## 13. 검증 기준

### 13.1 자동 검증

```sh
pnpm --filter @raibitserver/dashboard typecheck
pnpm --filter @raibitserver/dashboard build
node --test tests/dashboard-console.test.js tests/dashboard-tsconfig.test.js
npm test
node scripts/check-structure.js
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json
node src/cli.js compose examples/docker-compose.yml
```

Go가 설치되어 있으면 `services/*`의 구문 및 빌드 검사도 실행한다.

### 13.2 시각 검증

- 홈, 프로젝트 목록, 프로젝트 상세, 배포 상세, 리소스 콘솔, GitHub, 관리자, 로그인 화면을 확인한다.
- 데스크톱, 1180px 전후 태블릿, 900px 이하 모바일 폭을 확인한다.
- KPI가 좁고 긴 세로 카드로 변하지 않는지 확인한다.
- Heroicons가 축약되거나 깨지지 않고 동일한 선 굵기로 렌더링되는지 확인한다.
- 긴 한국어 레이블, 긴 프로젝트 이름, 빈 데이터, 오류 상태를 확인한다.
- `/errors` 전체 인덱스와 4xx·5xx 대표 화면(`/errors/404`, `/errors/422`, `/errors/500`, `/errors/507`) 및 실제 status를 반환하는 `/api/hosted-error?code=...`를 데스크톱·390px에서 확인한다.
- 각 반복에서 `visual-verdict` 90점 이상을 통과해야 완료로 판단한다.

## 14. 참고 자료

- 사용자 제공 `stitch_raibitserver_management_dashboard.zip`
- [ASTRYX Design System](https://astryx.atmeta.com/)
- [Heroicons](https://heroicons.com/)
- [Heroicons 기본 SVG 사용법](https://github.com/tailwindlabs/heroicons#basic-usage)

ASTRYX 라이브러리나 StyleX를 제품 의존성으로 도입하지 않는다. 참고 자료에서는 시각 계층, 여백, 라운드, 모듈성만 차용하며 RAIBITSERVER의 기존 Next.js·CSS 구조 안에서 구현한다.
