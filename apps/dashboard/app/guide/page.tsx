import { ConsoleShell, SectionNav } from '../../components/console-ui';

const topics = ['projects', 'source', 'environment', 'deployments', 'resources', 'github', 'administration'] as const;
type GuideTopic = typeof topics[number];

type Guide = {
  title: string;
  summary: string;
  paragraphs: string[];
  steps: Array<{ title: string; detail: string }>;
  note: string;
  next: { label: string; href: string };
};

const guides: Record<GuideTopic, Guide> = {
  projects: {
    title: '프로젝트 시작',
    summary: '처음 만드는 사람을 위한 4단계 안내',
    paragraphs: [
      '프로젝트는 웹 서비스 하나만 뜻하지 않습니다. 웹, 비공개 API, 워커와 예약 작업, 데이터베이스와 캐시를 한곳에서 관리하는 묶음입니다. 처음에는 대표 서비스 하나와 꼭 필요한 리소스만 만든 뒤 나중에 추가해도 됩니다.',
      '만들기 화면은 프로젝트, 저장소, 서비스, 리소스의 네 단계로 진행됩니다. 1~3단계의 다음 버튼과 Enter 입력은 화면만 이동하고, 4단계에서 프로젝트 만들기를 눌러야 서버로 제출됩니다.',
    ],
    steps: [
      { title: '이름과 슬러그 정하기', detail: '사람이 알아보기 쉬운 이름을 입력합니다. 슬러그를 비우면 서버가 안전한 식별자를 만들며 조직 범위는 로그인 권한으로 확인합니다.' },
      { title: '저장소 연결하기', detail: '대부분은 GitHub 저장소 URL과 main 브랜치만 입력하면 됩니다. 이미 만들어진 이미지가 있다면 이미지 방식을 선택합니다.' },
      { title: '첫 서비스 고르기', detail: '웹/API는 web, 내부 전용 서버는 private, 백그라운드 처리는 worker, 예약 작업은 cron, 일회성 처리는 job을 선택합니다.' },
      { title: '리소스 확인하고 생성하기', detail: 'PostgreSQL·MySQL·MongoDB와 Redis·Valkey 중 필요한 것만 고릅니다. 추가 안 함을 선택해도 나중에 리소스 화면에서 만들 수 있습니다.' },
    ],
    note: '4 / 4 화면에 도착하기 전에는 프로젝트가 생성되지 않습니다. 예전 화면이 보이면 새 Dashboard 배포와 브라우저 캐시를 확인하세요.',
    next: { label: '프로젝트 목록 열기', href: '/projects' },
  },
  source: {
    title: '소스 자동 인식',
    summary: '입력을 줄이는 Dockerfile·프레임워크 탐색',
    paragraphs: [
      '저장소를 연결하면 RAIBITSERVER가 먼저 사용자가 작성한 Dockerfile을 찾습니다. Dockerfile이 있으면 프레임워크 추정보다 항상 우선하며, 없을 때만 package manifest와 대표 설정 파일을 보고 빌드 계획을 만듭니다.',
      'lockfile을 기준으로 npm, pnpm, Yarn, Bun의 고정 설치 방식을 선택하고 Nuxt, SvelteKit, Astro, Django, Flask, Spring 같은 프로젝트 파일도 인식합니다. 확실하지 않은 경우 임의 명령을 실행하지 않고 서비스 설정에서 사용자의 입력을 기다립니다.',
    ],
    steps: [
      { title: '저장소 루트 확인', detail: '일반 저장소는 루트 경로를 비워 두거나 점 하나로 둡니다. monorepo라면 실제 서비스가 있는 하위 폴더만 지정합니다.' },
      { title: 'Dockerfile 우선 사용', detail: '저장소에 Dockerfile이 있으면 경로와 build context를 확인합니다. 경계를 벗어나는 절대 경로나 상위 디렉터리 이동은 거부됩니다.' },
      { title: '자동 계획 검토', detail: '서비스 설정에서 감지된 설치, 빌드, 시작 명령과 출력 경로, 포트를 확인합니다.' },
      { title: '필요할 때만 직접 수정', detail: '자동 감지가 틀린 항목만 직접 지정합니다. 실제 .env와 node_modules, .git은 탐색하지 않으며 .env.example에서는 키 이름만 읽습니다.' },
    ],
    note: '비밀값이 든 실제 .env 파일은 저장소에 올리지 마세요. .env.example에는 필요한 키 이름과 빈 값만 남기는 편이 안전합니다.',
    next: { label: 'GitHub 저장소 연결', href: '/github?step=attach' },
  },
  environment: {
    title: '환경 변수와 비밀키',
    summary: '서비스별 암호화 저장과 .env 가져오기',
    paragraphs: [
      '환경 변수 탭에서는 먼저 값을 연결할 서비스를 고릅니다. 공개해도 되는 설정은 일반값으로 저장하고, token·password·secret·connection string은 비밀값으로 저장하세요. 비밀값은 암호화되고 목록과 API 응답에는 마스킹된 형태만 나타납니다.',
      '여러 값은 .env 텍스트 가져오기에 KEY=value 형식으로 붙여 넣을 수 있습니다. 키 이름을 보고 비밀값 후보를 자동 분류하지만, 저장 전 분류가 맞는지 사용자가 한 번 확인하는 것이 좋습니다.',
    ],
    steps: [
      { title: '서비스 선택', detail: '같은 프로젝트라도 서비스마다 필요한 값이 다르므로 상단에서 대상 서비스를 정확히 선택합니다.' },
      { title: '키와 값 입력', detail: '키는 API_TOKEN처럼 영문자와 숫자, 밑줄을 사용합니다. 민감한 값이면 암호화 저장 옵션을 켭니다.' },
      { title: '.env 한꺼번에 가져오기', detail: '한 줄에 KEY=value 하나씩 붙여 넣습니다. 실제 파일을 브라우저 밖으로 전송하지 않고 입력한 텍스트만 API에 보냅니다.' },
      { title: '교체 후 배포', detail: '비밀값 수정 화면은 기존 원문을 다시 보여 주지 않습니다. 새 값을 입력해 교체한 뒤 서비스를 재배포합니다.' },
    ],
    note: '플랫폼 자체의 JWT, 암호화 키, registry와 signing credential은 tenant 화면이 아니라 서버 secret manager 또는 Kubernetes Secret으로 관리합니다.',
    next: { label: '프로젝트 목록 열기', href: '/projects' },
  },
  deployments: {
    title: 'AI 배포와 수동 배포',
    summary: '위협 점검부터 상태·로그 확인까지',
    paragraphs: [
      'AI 배포 탭은 외부 AI가 없어도 동작합니다. 내장된 결정적 규칙이 workload 권한, 이미지 digest, 저장소 URL, 위험 명령, 평문 비밀키를 먼저 검사합니다. critical 또는 high 위험이 하나라도 있으면 자동 실행 버튼을 차단합니다.',
      '외부 AI를 연결한 경우에도 전달되는 내용은 서비스 이름·유형과 위협 코드 같은 제한된 메타데이터뿐입니다. AI는 안전한 서비스의 순서를 제안할 수 있지만 서버의 보안 판정을 바꾸거나 secret을 볼 수 없습니다.',
    ],
    steps: [
      { title: 'AI 배포 계획 열기', detail: '프로젝트의 AI 배포 탭에서 서비스별 배포 가능 여부와 위협 코드를 확인합니다.' },
      { title: '차단 원인 수정', detail: '평문 secret은 환경 변수 보관함으로 옮기고, 이미지는 sha256 digest로 고정하며, 위험 명령과 과도한 권한을 제거합니다.' },
      { title: '검증된 계획 실행', detail: '실행 직전에 서버가 설정을 다시 읽어 검사합니다. 계획을 본 뒤 설정이 위험하게 바뀌었다면 배포하지 않습니다.' },
      { title: '배포와 로그 확인', detail: '배포 탭에서 build event와 image를 확인하고, 실행 중 문제는 로그 탭에서 봅니다. 한 서비스만 배포할 때는 서비스 목록의 운영 배포 또는 미리보기를 사용합니다.' },
    ],
    note: '배포 실패는 먼저 빌드 로그, root directory와 Dockerfile 경로, 필수 환경 변수, quota와 보안 차단 순서로 확인하세요.',
    next: { label: '프로젝트 목록 열기', href: '/projects' },
  },
  resources: {
    title: '관리형 리소스',
    summary: 'DB·캐시·스토리지를 서비스에 연결하기',
    paragraphs: [
      '리소스는 docker-compose에 임의 컨테이너를 추가하는 기능이 아닙니다. PostgreSQL, Redis, Object Storage 같은 카탈로그 항목을 선택하면 API가 원하는 상태를 기록하고 provisioner가 실제 상태를 맞춥니다.',
      '연결 정보는 공개 가능한 endpoint와 Secret reference로 나뉩니다. 자격 증명 원문을 일반 로그나 control-plane 응답에 복사하지 않으며, DB console의 schema 보기, row 읽기, 쓰기 권한도 따로 검사합니다.',
    ],
    steps: [
      { title: '엔진과 이름 선택', detail: '프로젝트 리소스 탭에서 필요한 엔진을 고르고 서비스에서 구분하기 쉬운 이름을 입력합니다.' },
      { title: '준비 상태 기다리기', detail: 'provisioner가 자격 증명, storage와 endpoint, 인증 probe를 확인해 READY로 바꿀 때까지 기다립니다.' },
      { title: '서비스 연결 확인', detail: '서비스에는 허용된 환경 변수 키별 Secret reference만 연결되는지 확인합니다.' },
      { title: '백업과 권한 준비', detail: 'production 전에는 백업, 복구, 용량 제한과 DB console 권한을 별도로 정합니다.' },
    ],
    note: '엔진별 live 지원 범위가 다릅니다. 화면에 항목이 있다는 사실만으로 production provider가 완성된 것으로 판단하지 마세요.',
    next: { label: '프로젝트 목록 열기', href: '/projects' },
  },
  github: {
    title: 'GitHub 연결',
    summary: '설치·가져오기·PR 미리보기',
    paragraphs: [
      'GitHub App은 계정 전체 권한 대신 배포할 저장소만 선택해 설치하는 방식을 권장합니다. callback에서 조직 소유권을 다시 확인하고, webhook은 shared secret으로 HMAC을 검증합니다.',
      '연결된 저장소의 push는 운영 workflow를, pull request는 별도 미리보기 workflow를 만들 수 있습니다. 미리보기는 운영 서비스와 다른 단일-label 주소를 사용하고 PR이 닫히면 정리 작업을 예약합니다.',
    ],
    steps: [
      { title: 'GitHub App 설치', detail: '개인 계정 또는 조직을 선택하고 RAIBITSERVER가 사용할 저장소만 허용합니다.' },
      { title: '저장소 가져오기', detail: '설치가 확인된 저장소 목록에서 대상을 고릅니다. 브라우저 폼으로 token이나 installation ID를 직접 보내지 않습니다.' },
      { title: '서비스에 연결', detail: '프로젝트와 서비스를 고른 뒤 저장소 metadata를 동기화합니다.' },
      { title: 'Webhook과 미리보기 확인', detail: 'push와 pull_request event가 서명 검증을 통과했는지 보고 preview 주소와 cleanup event를 확인합니다.' },
    ],
    note: '저장소 권한은 필요한 범위만 선택하고 webhook secret이 비어 있는 production 요청은 항상 거부해야 합니다.',
    next: { label: '저장소 연결 시작', href: '/github?step=connect' },
  },
  administration: {
    title: '사용자 승인과 밴',
    summary: '계정 접근을 안전하게 운영하기',
    paragraphs: [
      '새 가입자는 이메일 인증 뒤 승인 대기 상태가 됩니다. 관리자는 신청자의 이름, 학번, 이메일과 동아리원 신청 여부를 보고 클럽 회원 또는 일반 사용자로 승인할 수 있습니다.',
      '이용 제한이 필요하면 사유와 선택적 만료 시각을 기록해 밴합니다. 밴 즉시 session version이 바뀌어 기존 로그인 세션이 무효화되고, 로그인과 보호된 작업이 모두 차단됩니다.',
    ],
    steps: [
      { title: '신청 정보 확인', detail: '표시된 신원 정보가 운영 규칙과 맞는지 확인합니다. 승인 유형에 따라 quota와 역할 범위가 달라질 수 있습니다.' },
      { title: '승인 또는 거절', detail: '클럽 회원 승인, 일반 사용자 승인, 확인 절차가 있는 거절 중 하나를 선택합니다.' },
      { title: '필요한 계정 밴', detail: '500자 이하의 구체적인 사유를 적고, 임시 제한이면 미래의 해제 시각을 입력합니다. 비우면 영구 제한입니다.' },
      { title: '감사 기록과 해제', detail: '관리 작업과 사유를 감사 로그에서 확인합니다. 문제가 해결되면 밴 해제로 새 로그인을 허용합니다.' },
    ],
    note: '관리자는 자기 자신을 밴할 수 없습니다. 운영 접근을 잃지 않도록 최소 두 명의 검증된 관리자와 별도 복구 절차를 준비하세요.',
    next: { label: '관리자 화면 열기', href: '/admin' },
  },
};

export default async function GuidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedTopic = String(query.topic || 'projects');
  const topic: GuideTopic = topics.includes(requestedTopic as GuideTopic) ? requestedTopic as GuideTopic : 'projects';
  const guide = guides[topic];
  const navItems = [
    { id: 'projects', label: '프로젝트', description: '4단계 시작', href: '/guide?topic=projects' },
    { id: 'source', label: '자동 인식', description: '파일·프레임워크', href: '/guide?topic=source' },
    { id: 'environment', label: '비밀키', description: '환경 변수', href: '/guide?topic=environment' },
    { id: 'deployments', label: '배포', description: 'AI·로그', href: '/guide?topic=deployments' },
    { id: 'resources', label: '리소스', description: 'DB·캐시', href: '/guide?topic=resources' },
    { id: 'github', label: 'GitHub', description: '저장소·PR', href: '/guide?topic=github' },
    { id: 'administration', label: '관리', description: '승인·밴', href: '/guide?topic=administration' },
  ];

  return (
    <ConsoleShell active="guide">
      <section className="page page-focus">
        <header className="page-header"><div><p className="eyebrow">RAIBIT GUIDE</p><h1 className="page-title">사용 안내</h1><p className="page-subtitle">처음 시작하는 사람의 눈높이로 설명합니다.</p></div></header>
        <SectionNav items={navItems} current={topic} label="사용 안내 주제" />
        <article className="guide-article">
          <header><p className="eyebrow">{guide.summary}</p><h2>{guide.title}</h2></header>
          <section className="guide-prose" aria-label={`${guide.title} 설명`}>
            {guide.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
          <ol className="guide-steps">
            {guide.steps.map((step, index) => <li key={step.title}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}
          </ol>
          <aside className="guide-note"><strong>알아두기</strong><p>{guide.note}</p></aside>
          <div className="workflow-actions"><a className="btn btn-primary" href={guide.next.href}>{guide.next.label}</a><a className="btn" href="https://github.com/jsk1004ha/RaibitServer/blob/main/docs/getting-started.md">전체 사용 설명서</a></div>
        </article>
      </section>
    </ConsoleShell>
  );
}
