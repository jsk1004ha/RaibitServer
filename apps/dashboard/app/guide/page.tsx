import { ConsoleShell, SectionNav } from '../../components/console-ui';

const topics = ['projects', 'deployments', 'resources', 'github'] as const;
type GuideTopic = typeof topics[number];

const guides: Record<GuideTopic, { title: string; summary: string; steps: Array<{ title: string; detail: string }>; note: string }> = {
  projects: {
    title: '프로젝트 시작',
    summary: '저장소에서 첫 배포까지',
    steps: [
      { title: '프로젝트 만들기', detail: '이름과 조직 선택' },
      { title: '저장소 연결', detail: 'GitHub 저장소 선택' },
      { title: '서비스 만들기', detail: 'Dockerfile 또는 이미지' },
      { title: '배포 확인', detail: '상태와 로그 확인' },
    ],
    note: 'Dockerfile이 있으면 자동 감지보다 우선합니다.',
  },
  deployments: {
    title: '배포 관리',
    summary: '상태·로그·복구',
    steps: [
      { title: '배포 시작', detail: '운영 또는 미리보기' },
      { title: '상태 확인', detail: '빌드와 실행 상태' },
      { title: '로그 확인', detail: '오류 원인 확인' },
      { title: '복구 선택', detail: '재배포 또는 롤백' },
    ],
    note: '실패하면 먼저 빌드 로그를 확인하세요.',
  },
  resources: {
    title: '리소스 사용',
    summary: 'DB·캐시·스토리지',
    steps: [
      { title: '리소스 추가', detail: '엔진과 이름 선택' },
      { title: '데이터 구조', detail: '테이블·키 확인' },
      { title: '쿼리 실행', detail: '읽기부터 시작' },
      { title: '서비스 연결', detail: '환경 변수 자동 주입' },
    ],
    note: '자격 증명은 화면과 로그에서 마스킹됩니다.',
  },
  github: {
    title: 'GitHub 연결',
    summary: '설치·가져오기·동기화',
    steps: [
      { title: 'GitHub App 설치', detail: '조직 또는 계정 선택' },
      { title: '저장소 가져오기', detail: '대상 저장소 선택' },
      { title: '프로젝트 연결', detail: '서비스와 저장소 연결' },
      { title: '동기화 확인', detail: '웹훅 상태 확인' },
    ],
    note: '저장소 권한은 필요한 범위만 선택하세요.',
  },
};

export default async function GuidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedTopic = String(query.topic || 'projects');
  const topic: GuideTopic = topics.includes(requestedTopic as GuideTopic) ? requestedTopic as GuideTopic : 'projects';
  const guide = guides[topic];
  const navItems = [
    { id: 'projects', label: '프로젝트', href: '/guide?topic=projects' },
    { id: 'deployments', label: '배포', href: '/guide?topic=deployments' },
    { id: 'resources', label: '리소스', href: '/guide?topic=resources' },
    { id: 'github', label: 'GitHub', href: '/guide?topic=github' },
  ];

  return (
    <ConsoleShell active="guide">
      <section className="page page-focus">
        <header className="page-header"><div><p className="eyebrow">RAIBIT GUIDE</p><h1 className="page-title">사용 안내</h1><p className="page-subtitle">필요한 내용만 빠르게</p></div></header>
        <SectionNav items={navItems} current={topic} label="사용 안내 주제" />
        <article className="guide-article">
          <header><p className="eyebrow">{guide.summary}</p><h2>{guide.title}</h2></header>
          <ol className="guide-steps">
            {guide.steps.map((step, index) => <li key={step.title}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}
          </ol>
          <aside className="guide-note"><strong>알아두기</strong><p>{guide.note}</p></aside>
        </article>
      </section>
    </ConsoleShell>
  );
}
