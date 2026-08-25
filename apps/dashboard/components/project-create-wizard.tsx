'use client';

import { useRef, useState } from 'react';

const steps = [
  { id: 'project', label: '프로젝트', description: '이름과 식별자' },
  { id: 'source', label: '저장소', description: '코드 위치 연결' },
  { id: 'service', label: '서비스', description: '첫 실행 단위' },
  { id: 'resources', label: '리소스', description: '데이터 계층 선택' },
] as const;

export function ProjectCreateWizard({ action, orgSlug }: { action: string; orgSlug: string }) {
  const [step, setStep] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const activeStep = steps[step];

  function moveNext() {
    const activePanel = formRef.current?.querySelector<HTMLElement>(`[data-step="${activeStep.id}"]`);
    const invalid = activePanel?.querySelector<HTMLInputElement | HTMLSelectElement>(':invalid');
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  return (
    <form ref={formRef} method="post" action={action} className="workflow-form workflow-form-wide card">
      <input type="hidden" name="_returnTo" value={`/org/${orgSlug}/projects`} />
      <ol className="workflow-steps" aria-label="프로젝트 만들기 단계">
        {steps.map((item, index) => (
          <li key={item.id} className={index === step ? 'active' : index < step ? 'complete' : ''} aria-current={index === step ? 'step' : undefined}>
            <button type="button" onClick={() => index <= step && setStep(index)} disabled={index > step}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </button>
          </li>
        ))}
      </ol>

      <div className="workflow-stage">
        <section className="stack" data-step="project" hidden={step !== 0}>
          <div><p className="eyebrow">STEP 01</p><h2>프로젝트 기본 정보</h2><p className="muted">콘솔과 주소에 표시할 프로젝트 정보를 먼저 정합니다.</p></div>
          <div className="form-grid">
            <label>프로젝트 이름 <input name="name" required placeholder="동아리 웹사이트" /></label>
            <label>슬러그 <input name="slug" placeholder="club-website" /></label>
            <label>조직 <input value={orgSlug} readOnly aria-describedby="organization-scope-note" /></label>
            <p className="muted" id="organization-scope-note">로그인 권한으로 확인</p>
          </div>
        </section>

        <section className="stack" data-step="source" hidden={step !== 1}>
          <div><p className="eyebrow">STEP 02</p><h2>저장소 연결</h2><p className="muted">배포할 코드 또는 이미지를 선택합니다. Dockerfile이 있으면 가장 먼저 사용합니다.</p></div>
          <div className="form-grid">
            <label>소스 유형 <select name="sourceType" defaultValue="github"><option value="github">GitHub / Git 저장소</option><option value="image">빌드된 이미지</option><option value="local">로컬 Dockerfile</option></select></label>
            <label>저장소 URL <input name="repoUrl" placeholder="https://github.com/raibit/club-api" /></label>
            <label>브랜치 <input name="branch" defaultValue="main" /></label>
          </div>
        </section>

        <section className="stack" data-step="service" hidden={step !== 2}>
          <div><p className="eyebrow">STEP 03</p><h2>첫 서비스</h2><p className="muted">프로젝트에서 가장 먼저 실행할 컨테이너 유형을 지정합니다.</p></div>
          <div className="form-grid">
            <label>서비스 이름 <input name="serviceName" defaultValue="web" required /></label>
            <label>서비스 유형 <select name="type" defaultValue="web"><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></select></label>
            <label>이미지 <input name="image" placeholder="registry.example.com/team/web:tag" /></label>
            <label>Dockerfile 경로 <input name="dockerfilePath" placeholder="Dockerfile" /></label>
            <label>빌드 컨텍스트 <input name="buildContext" defaultValue="." /></label>
          </div>
        </section>

        <section className="stack" data-step="resources" hidden={step !== 3}>
          <div><p className="eyebrow">STEP 04</p><h2>관리형 리소스</h2><p className="muted">지금 필요한 데이터베이스와 캐시만 선택하세요. 나중에 프로젝트 콘솔에서도 추가할 수 있습니다.</p></div>
          <div className="form-grid">
            <label>데이터베이스 <select name="database" defaultValue="none"><option value="none">추가 안 함</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></select></label>
            <label>캐시 <select name="cache" defaultValue="none"><option value="none">추가 안 함</option><option value="redis">Redis</option><option value="valkey">Valkey</option></select></label>
          </div>
          <p className="callout">연결 보안 정보는 서비스 환경 변수에 마스킹된 값으로 연결되며 원문은 콘솔에 표시하지 않습니다.</p>
        </section>
      </div>

      <div className="workflow-actions">
        {step === 0 ? <a className="btn" href={`/org/${orgSlug}/projects`}>취소</a> : <button className="btn" type="button" onClick={() => setStep((current) => Math.max(0, current - 1))}>이전</button>}
        <span className="muted">{step + 1} / {steps.length}</span>
        {step < steps.length - 1 ? <button className="btn btn-primary" type="button" onClick={moveNext}>다음</button> : <button className="btn btn-primary" type="submit">프로젝트 만들기</button>}
      </div>
    </form>
  );
}
