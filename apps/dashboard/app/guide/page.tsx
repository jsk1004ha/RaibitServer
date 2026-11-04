import { ArrowRightIcon, BookOpenIcon, InfoIcon } from 'lucide-react';
import Link from 'next/link';
import { ConsoleShell } from '../../components/console-ui';
import { PublicHeader } from '../../components/public-header';
import { selectedWorkspace } from '../../lib/workspace-context';
import { dashboardApiContext, getJson } from '../../lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { SectionNavigationScroll } from '../../components/section-navigation-scroll';

const topics = ['organizations', 'projects', 'source', 'environment', 'deployments', 'resources', 'github', 'administration'] as const;
type GuideTopic = typeof topics[number];

const navItems = [
  { id: 'organizations', label: '처음 시작하기', description: '작업 공간 이해하기', href: '/guide?topic=organizations' },
  { id: 'projects', label: '프로젝트', description: '이름과 코드 선택', href: '/guide?topic=projects' },
  { id: 'source', label: '자동 인식', description: '파일·프레임워크', href: '/guide?topic=source' },
  { id: 'environment', label: '비밀키', description: '환경 변수', href: '/guide?topic=environment' },
  { id: 'deployments', label: '배포와 로그', description: '실행·오류 확인', href: '/guide?topic=deployments' },
  { id: 'resources', label: '리소스', description: 'DB·캐시', href: '/guide?topic=resources' },
  { id: 'github', label: 'GitHub', description: '저장소·PR', href: '/guide?topic=github' },
  { id: 'administration', label: '관리', description: '승인·밴', href: '/guide?topic=administration' },
] as const;

type Guide = {
  title: string;
  summary: string;
  paragraphs: string[];
  steps: Array<{ title: string; detail: string }>;
  note: string;
  next: { label: string; destination: 'projects' | 'github' | 'admin' };
};

const guides: Record<GuideTopic, Guide> = {
  organizations: {
    title: '처음이라면 여기부터',
    summary: '작업 공간 → 프로젝트 → 서비스',
    paragraphs: [
      '라이빗은 만든 웹사이트나 봇을 서버에서 실행하고 관리하는 서비스입니다. 가입 신청과 이메일 인증을 마친 뒤 관리자의 승인을 받으면 프로젝트를 만들 수 있습니다.',
      '작업 공간은 프로젝트와 팀원을 함께 관리하는 곳입니다. 혼자 쓰더라도 작업 공간 안에 프로젝트를 만들고, 함께 개발할 때는 같은 공간에 팀원을 초대합니다. GitHub의 조직과는 별개입니다.',
    ],
    steps: [
      { title: '작업 공간 확인하기', detail: '왼쪽 위에서 현재 공간을 확인합니다. 여러 공간에 참여했다면 메뉴에서 바꿀 수 있습니다. 모바일에서는 콘솔 메뉴를 먼저 여세요.' },
      { title: '프로젝트 만들기', detail: '새 프로젝트를 누르고 이름과 코드 저장소를 입력합니다. 동아리 홈페이지, 개인 봇처럼 함께 관리할 단위로 나누세요.' },
      { title: '실행할 서비스 설정하기', detail: '프로젝트 안에 웹사이트나 봇을 서비스로 추가합니다. 데이터베이스가 필요할 때만 리소스를 추가하세요.' },
      { title: '배포하고 주소 열기', detail: '필요한 환경 변수를 저장하고 배포합니다. 완료되면 웹 서비스 주소를 열고, 문제가 있으면 배포 내역과 로그를 확인하세요.' },
    ],
    note: '작업 공간을 바꿔도 프로젝트가 이동하지는 않습니다. 새 작업 공간이 꼭 필요한 게 아니라면 현재 공간을 그대로 사용하면 됩니다. 접근할 공간이 보이지 않으면 관리자에게 초대를 요청하세요.',
    next: { label: '내 프로젝트 확인하기', destination: 'projects' },
  },
  projects: {
    title: '프로젝트 시작',
    summary: '이름과 실행할 코드만 준비하세요',
    paragraphs: [
      '프로젝트는 웹 서비스 하나만 뜻하지 않습니다. 웹, 비공개 API, 워커와 예약 작업, 데이터베이스와 캐시를 한곳에서 관리하는 묶음입니다. 처음에는 대표 서비스 하나와 꼭 필요한 리소스만 만든 뒤 나중에 추가해도 됩니다.',
      '새 프로젝트 화면에서 이름과 코드를 가져올 곳을 선택합니다. 필요한 설정만 입력한 뒤 프로젝트 만들기를 누르면 생성됩니다.',
    ],
    steps: [
      { title: '이름 정하기', detail: '동아리 홈페이지처럼 알아보기 쉬운 이름을 입력합니다. 주소 이름은 자동으로 제안되며 필요하면 바꿀 수 있습니다.' },
      { title: '저장소 연결하기', detail: '대부분은 GitHub 저장소 URL과 main 브랜치만 입력하면 됩니다. 이미 만들어진 이미지가 있다면 이미지 방식을 선택합니다.' },
      { title: '필요한 설정만 추가하기', detail: '기본 설정으로 시작할 수 있습니다. 실행 방식이나 빌드 명령을 바꾸거나 데이터베이스가 필요할 때만 추가 설정을 여세요.' },
      { title: '프로젝트 만들기', detail: '입력한 내용을 확인하고 프로젝트 만들기를 누릅니다. 데이터베이스와 서비스는 나중에도 추가할 수 있습니다.' },
    ],
    note: '프로젝트를 만드는 것과 배포하는 것은 다릅니다. 생성 후 필요한 환경 변수를 먼저 넣고 배포를 시작하세요.',
    next: { label: '프로젝트 목록 열기', destination: 'projects' },
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
    next: { label: 'GitHub 저장소 연결', destination: 'github' },
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
      { title: '.env 한꺼번에 가져오기', detail: '한 줄에 KEY=value 하나씩 붙여 넣습니다. 저장 전에 변수 이름과 값을 확인하세요.' },
      { title: '교체 후 배포', detail: '비밀값 수정 화면은 기존 원문을 다시 보여 주지 않습니다. 새 값을 입력해 교체한 뒤 서비스를 재배포합니다.' },
    ],
    note: '비밀번호나 API 키를 코드 저장소에 올리지 마세요. 이미 공개했다면 환경 변수로 옮기는 것뿐 아니라 해당 서비스에서 키를 새로 발급해야 합니다.',
    next: { label: '프로젝트 목록 열기', destination: 'projects' },
  },
  deployments: {
    title: '배포하고 로그 확인하기',
    summary: '코드를 실행하고 문제가 생긴 지점 찾기',
    paragraphs: [
      '배포는 저장소의 코드를 빌드하고 서버에서 실행하는 과정입니다. 코드를 수정한 뒤에는 다시 배포해야 실행 중인 서비스에 반영됩니다.',
      '배포 내역에서는 빌드와 실행 상태를, 로그에서는 서비스가 출력한 내용을 확인합니다. 여러 서비스가 있다면 먼저 확인할 서비스를 선택하세요.',
    ],
    steps: [
      { title: '배포 전 설정 확인', detail: '저장소와 브랜치, 시작 명령, 포트, 필요한 환경 변수가 맞는지 확인합니다.' },
      { title: '서비스 배포하기', detail: '서비스에서 운영 배포를 선택합니다. 운영 중인 서비스와 분리해 확인하려면 미리보기를 사용하세요.' },
      { title: '완료 상태 확인', detail: '배포 내역에서 진행 상태를 확인하고, 준비가 완료되면 서비스 주소를 열어 실제로 사용해 보세요.' },
      { title: '실패 지점 찾기', detail: '빌드 실패라면 설치·빌드 로그를, 실행 후 종료된다면 서비스 로그와 환경 변수를 확인합니다. 오류 메시지와 배포 시각을 함께 남기면 문의할 때 도움이 됩니다.' },
    ],
    note: 'AI 배포는 추가 점검을 돕는 기능입니다. 일반 배포를 시작하기 위해 외부 AI를 연결할 필요는 없습니다.',
    next: { label: '프로젝트 목록 열기', destination: 'projects' },
  },
  resources: {
    title: '관리형 리소스',
    summary: 'DB·캐시·스토리지를 서비스에 연결하기',
    paragraphs: [
      '리소스는 서비스에서 사용할 데이터베이스, 캐시, 파일 저장 공간입니다. 단순한 정적 웹사이트라면 추가하지 않아도 됩니다.',
      '프로젝트의 리소스 화면에서 필요한 종류를 선택하고 준비 상태를 확인하세요. 생성 후 연결 정보를 서비스의 환경 변수에 설정해야 코드에서 사용할 수 있습니다.',
    ],
    steps: [
      { title: '엔진과 이름 선택', detail: '프로젝트 리소스 탭에서 필요한 엔진을 고르고 서비스에서 구분하기 쉬운 이름을 입력합니다.' },
      { title: '준비 상태 기다리기', detail: '리소스가 준비 완료 상태가 될 때까지 기다립니다. 오류가 표시되면 상세 화면의 안내를 확인하세요.' },
      { title: '서비스에 연결하기', detail: '연결 안내에 따라 서비스 환경 변수를 설정하고 재배포합니다. 연결 비밀번호를 로그나 공개 저장소에 남기지 마세요.' },
      { title: '데이터 보관 확인', detail: '중요한 데이터를 넣기 전 백업 방법과 용량 제한을 확인하세요. 리소스를 삭제하기 전에는 필요한 데이터를 따로 보관해야 합니다.' },
    ],
    note: '사용할 수 있는 리소스 종류는 서버 설정에 따라 다릅니다. 준비되지 않거나 생성이 막히면 관리자에게 문의하세요.',
    next: { label: '프로젝트 목록 열기', destination: 'projects' },
  },
  github: {
    title: 'GitHub 연결',
    summary: '설치·가져오기·PR 미리보기',
    paragraphs: [
      '저장소 연결은 GitHub의 코드를 가져와 배포하기 위한 기능입니다. 로그인 화면의 GitHub로 로그인과는 별개이므로 이메일로 로그인한 계정도 저장소를 연결할 수 있습니다.',
      'GitHub 연결 화면에서 앱을 설치하고 사용할 저장소를 선택하세요. 다른 사람의 저장소라면 먼저 저장소 관리자에게 설치 권한을 요청해야 할 수 있습니다.',
    ],
    steps: [
      { title: 'GitHub App 설치', detail: '개인 계정 또는 조직을 선택하고 RAIBITSERVER가 사용할 저장소만 허용합니다.' },
      { title: '저장소 고르기', detail: '접근을 허용한 저장소 목록에서 배포할 저장소를 선택합니다. 목록에 없으면 GitHub 앱의 저장소 접근 권한을 확인하세요.' },
      { title: '서비스에 연결', detail: '코드를 사용할 프로젝트와 서비스를 선택하고 브랜치와 빌드 설정을 확인합니다.' },
      { title: '변경 사항 배포', detail: '코드를 올린 뒤 새 배포가 시작되는지 확인합니다. 자동 배포가 설정되지 않았다면 서비스 화면에서 직접 배포하세요.' },
    ],
    note: 'GitHub 연결 설정이 없다는 안내는 서버 관리자 설정이 필요하다는 뜻입니다. 반복해서 연결을 눌러도 해결되지 않으므로 관리자에게 문의하세요.',
    next: { label: '저장소 연결 시작', destination: 'github' },
  },
  administration: {
    title: '사용자 승인과 밴',
    summary: '계정 접근을 안전하게 운영하기',
    paragraphs: [
      '새 가입자는 이메일 인증 뒤 승인 대기 상태가 됩니다. 관리자는 신청자의 이름, 학번, 이메일과 동아리원 신청 여부를 보고 클럽 회원 또는 일반 사용자로 승인할 수 있습니다.',
      '이용 제한이 필요하면 사유와 해제 시각을 기록합니다. 제한된 계정은 로그아웃되며, 제한을 해제하기 전까지 다시 이용할 수 없습니다.',
    ],
    steps: [
      { title: '신청 정보 확인', detail: '표시된 신원 정보가 운영 규칙과 맞는지 확인합니다. 승인 유형에 따라 사용량 한도와 권한이 달라질 수 있습니다.' },
      { title: '승인 또는 거절', detail: '클럽 회원 승인, 일반 사용자 승인, 확인 절차가 있는 거절 중 하나를 선택합니다.' },
      { title: '필요한 계정 밴', detail: '500자 이하의 구체적인 사유를 적고, 임시 제한이면 미래의 해제 시각을 입력합니다. 비우면 영구 제한입니다.' },
      { title: '감사 기록과 해제', detail: '관리 작업과 사유를 감사 로그에서 확인합니다. 문제가 해결되면 밴 해제로 새 로그인을 허용합니다.' },
    ],
    note: '관리자는 자기 자신을 밴할 수 없습니다. 운영 접근을 잃지 않도록 최소 두 명의 검증된 관리자와 별도 복구 절차를 준비하세요.',
    next: { label: '관리자 화면 열기', destination: 'admin' },
  },
};

export default async function GuidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await dashboardApiContext();
  const [query, me] = await Promise.all([
    searchParams,
    context.token ? getJson('/auth/me', { user: null, subject: null }, context) : Promise.resolve(null),
  ]);
  const requestedTopic = String(query.topic || 'organizations');
  const topic: GuideTopic = topics.includes(requestedTopic as GuideTopic) ? requestedTopic as GuideTopic : 'organizations';
  const guide = guides[topic];
  const authenticated = Boolean(me?.ok);
  const orgSlug = me?.ok ? await selectedWorkspace({ subject: me.body?.subject, memberships: me.body?.memberships }) : '';
  const nextHref = guide.next.destination === 'projects'
    ? orgSlug ? `/org/${encodeURIComponent(orgSlug)}/projects` : '/console'
    : guide.next.destination === 'admin' ? '/admin' : topic === 'source' ? '/github?step=attach' : '/github?step=connect';
  const content = (
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
        <header className="border-b border-border pb-6"><p className="mb-1.5 text-xs font-medium text-muted-foreground">RAIBIT GUIDE</p><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-[1.75rem]">사용 안내</h1><p className="mt-1.5 max-w-2xl text-sm text-muted-foreground break-keep">처음 시작하는 방법부터 배포 오류 확인까지. 지금 하려는 작업을 골라 따라 해 보세요.</p></header>
        <div className="grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <nav aria-label="사용 안내 주제" className="min-w-0"><SectionNavigationScroll as="ul" current={topic} viewportClassName="gap-2 pb-1 lg:flex-col lg:overflow-visible">{navItems.map((item) => { const current = item.id === topic; return <li key={item.id} className="min-w-36 lg:min-w-0"><Link className={cn('flex min-h-14 flex-col justify-center rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25', current ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-card text-foreground hover:bg-muted')} aria-current={current ? 'page' : undefined} href={item.href}><strong className="font-medium">{item.label}</strong><span className={cn('text-xs', current ? 'text-primary' : 'text-muted-foreground')}>{item.description}</span></Link></li>; })}</SectionNavigationScroll></nav>
          <article className="flex min-w-0 flex-col gap-5">
            <Card>
              <CardHeader className="border-b"><Badge variant="secondary" className="mb-1">{guide.summary}</Badge><CardTitle><h2 className="text-xl md:text-2xl break-keep">{guide.title}</h2></CardTitle><CardDescription>{authenticated ? '왼쪽 위에서 작업 공간을 선택하고 해당 프로젝트로 이동할 수 있습니다.' : '가입 전에 준비할 내용과 이용 순서를 확인하세요.'}</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-6">
                <section className="flex flex-col gap-3 text-sm leading-7 text-foreground" aria-label={`${guide.title} 설명`}>{guide.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section>
                <ol className="grid gap-3">{guide.steps.map((step, index) => <li key={step.title} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border border-border bg-background p-4"><span className="flex size-7 items-center justify-center rounded-full bg-primary-soft text-xs font-medium text-primary" aria-hidden="true">{index + 1}</span><div className="min-w-0"><strong className="text-sm font-medium text-foreground">{step.title}</strong><p className="mt-1 text-sm leading-6 text-muted-foreground">{step.detail}</p></div></li>)}</ol>
                <Alert variant="notice"><InfoIcon /><AlertTitle>알아두기</AlertTitle><AlertDescription>{guide.note}</AlertDescription></Alert>
              </CardContent>
            </Card>
            <div className="flex flex-wrap gap-2"><Link className={buttonVariants()} href={authenticated ? nextHref : '/login?mode=signup'}>{authenticated ? guide.next.label : '가입 신청하기'}<ArrowRightIcon data-icon="inline-end" /></Link><a className={buttonVariants({ variant: 'outline' })} href="https://github.com/jsk1004ha/RaibitServer/blob/main/docs/handbook/README.md"><BookOpenIcon data-icon="inline-start" />전체 사용 설명서</a><Link className={buttonVariants({ variant: 'outline' })} href="/support">문의하기</Link></div>
            <p className="sr-only">선택한 안내 주제는 주소에 저장되어 브라우저 뒤로 가기와 앞으로 가기로 이동할 수 있습니다.</p>
          </article>
        </div>
      </section>
  );
  return authenticated
    ? <ConsoleShell active="guide" orgRouteValue={orgSlug} projectValue="사용 안내">{content}</ConsoleShell>
    : <><PublicHeader currentPath="/guide" /><main id="main-content">{content}</main></>;
}
