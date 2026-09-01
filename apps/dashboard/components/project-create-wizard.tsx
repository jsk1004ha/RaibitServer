'use client';

import { type FormEvent, type MouseEvent, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  isFinalProjectWizardStep,
  nextProjectWizardStep,
  previousProjectWizardStep,
  projectWizardStepIndex,
  projectWizardSteps,
  type ProjectWizardStepId,
} from './project-create-wizard-state';

export function ProjectCreateWizard({ action, orgSlug }: { action: string; orgSlug: string }) {
  const [stepId, setStepId] = useState<ProjectWizardStepId>('project');
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const step = projectWizardStepIndex(stepId);
  const activeStep = projectWizardSteps[step];
  const finalStep = isFinalProjectWizardStep(stepId);

  useLayoutEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [stepId]);

  function moveNext() {
    const activePanel = formRef.current?.querySelector<HTMLElement>(`[data-step="${activeStep.id}"]`);
    const invalid = activePanel?.querySelector<HTMLInputElement | HTMLSelectElement>(':invalid');
    if (invalid) { invalid.reportValidity(); invalid.focus(); return; }
    if (stepId === 'service') { setStepId('resources'); return; }
    if (!finalStep) setStepId(nextProjectWizardStep(stepId));
  }

  function handleNextClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    moveNext();
  }

  function guardSubmit(event: FormEvent<HTMLFormElement>) {
    if (finalStep) return;
    event.preventDefault();
    moveNext();
  }

  return (
    <form ref={formRef} method="post" action={action} onSubmit={guardSubmit} className="grid min-w-0 gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]" data-project-create-form>
      <input type="hidden" name="_returnTo" value={`/org/${orgSlug}/projects`} />
      <nav aria-label="프로젝트 만들기 단계" className="min-w-0">
        <ol className="flex min-w-0 gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {projectWizardSteps.map((item, index) => {
            const current = index === step;
            const complete = index < step;
            return (
              <li key={item.id} className="min-w-36 flex-1 lg:min-w-0">
                <button type="button" onClick={() => index <= step && setStepId(item.id)} disabled={index > step} aria-current={current ? 'step' : undefined} className={cn('flex min-h-16 w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45', current ? 'border-primary bg-primary-soft text-primary' : complete ? 'border-border bg-card text-foreground hover:bg-muted' : 'border-border bg-background text-muted-foreground')}>
                  <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium', current ? 'border-primary bg-primary text-primary-foreground' : complete ? 'border-primary text-primary' : 'border-border')} aria-hidden="true">{complete ? <CheckIcon /> : index + 1}</span>
                  <span className="flex min-w-0 flex-col gap-0.5"><strong className="text-sm font-medium">{item.label}</strong><small className={cn('text-xs', current ? 'text-primary' : 'text-muted-foreground')}>{item.description}</small></span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <Card className="min-w-0">
        <CardHeader className="border-b">
          <p className="text-xs font-medium text-muted-foreground">STEP {String(step + 1).padStart(2, '0')}</p>
          <CardTitle><h2 ref={headingRef} tabIndex={-1} className="outline-none" data-active-step-heading>{activeStep.heading}</h2></CardTitle>
          <CardDescription>{step === 0 ? '콘솔과 주소에 표시할 프로젝트 정보를 먼저 정합니다.' : step === 1 ? '배포할 코드 또는 이미지를 선택합니다. Dockerfile이 있으면 프레임워크 추정보다 항상 우선합니다.' : step === 2 ? '프로젝트에서 가장 먼저 실행할 컨테이너 유형을 지정합니다.' : '지금 필요한 데이터베이스와 캐시만 선택하세요. 나중에도 추가할 수 있습니다.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <section data-step="project" hidden={step !== 0} aria-labelledby="project-step-heading">
            <span id="project-step-heading" className="sr-only">프로젝트 기본 정보 입력</span>
            <FieldGroup>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="project-name">프로젝트 이름</FieldLabel><Input id="project-name" name="name" required placeholder="동아리 웹사이트" autoComplete="off" /><FieldDescription>사람이 알아보기 쉬운 이름을 입력하세요.</FieldDescription></Field>
                <Field><FieldLabel htmlFor="project-slug">슬러그</FieldLabel><Input id="project-slug" name="slug" placeholder="club-website" autoCapitalize="none" spellCheck={false} /><FieldDescription>비우면 서버가 안전한 식별자를 만듭니다.</FieldDescription></Field>
              </div>
              <Field><FieldLabel htmlFor="project-organization">조직</FieldLabel><Input id="project-organization" value={orgSlug} readOnly aria-describedby="organization-scope-note" /><FieldDescription id="organization-scope-note">조직은 로그인 권한으로 확인되며 폼으로 제출하지 않습니다.</FieldDescription></Field>
            </FieldGroup>
          </section>

          <section data-step="source" hidden={step !== 1} aria-labelledby="source-step-heading">
            <span id="source-step-heading" className="sr-only">저장소 연결 입력</span>
            <FieldGroup>
              <Field><FieldLabel htmlFor="source-type">소스 유형</FieldLabel><Select id="source-type" name="sourceType" defaultValue="github"><option value="github">GitHub / Git 저장소</option><option value="image">빌드된 이미지</option><option value="local">로컬 Dockerfile</option></Select></Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="repo-url">저장소 URL</FieldLabel><Input id="repo-url" name="repoUrl" type="url" inputMode="url" placeholder="https://github.com/raibit/club-api" /></Field>
                <Field><FieldLabel htmlFor="branch">브랜치</FieldLabel><Input id="branch" name="branch" defaultValue="main" autoCapitalize="none" spellCheck={false} /></Field>
              </div>
              <Alert variant="notice"><ShieldCheckIcon /><AlertTitle>Dockerfile 우선</AlertTitle><AlertDescription>저장소에 Dockerfile이 있으면 프레임워크 자동 인식보다 먼저 사용합니다.</AlertDescription></Alert>
            </FieldGroup>
          </section>

          <section data-step="service" hidden={step !== 2} aria-labelledby="service-step-heading">
            <span id="service-step-heading" className="sr-only">첫 서비스 입력</span>
            <FieldGroup>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="service-name">서비스 이름</FieldLabel><Input id="service-name" name="serviceName" defaultValue="web" required /></Field>
                <Field><FieldLabel htmlFor="service-type">서비스 유형</FieldLabel><Select id="service-type" name="type" defaultValue="web"><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></Select></Field>
              </div>
              <Field><FieldLabel htmlFor="service-image">이미지</FieldLabel><Input id="service-image" name="image" placeholder="registry.example.com/team/web:tag" autoCapitalize="none" spellCheck={false} /></Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="dockerfile-path">Dockerfile 경로</FieldLabel><Input id="dockerfile-path" name="dockerfilePath" placeholder="Dockerfile" autoCapitalize="none" spellCheck={false} /></Field>
                <Field><FieldLabel htmlFor="build-context">빌드 컨텍스트</FieldLabel><Input id="build-context" name="buildContext" defaultValue="." autoCapitalize="none" spellCheck={false} /></Field>
              </div>
            </FieldGroup>
          </section>

          <section data-step="resources" hidden={step !== 3} aria-labelledby="resources-step-heading">
            <span id="resources-step-heading" className="sr-only">관리형 리소스 선택</span>
            <FieldGroup>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="database">데이터베이스</FieldLabel><Select id="database" name="database" defaultValue="none"><option value="none">추가 안 함</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></Select></Field>
                <Field><FieldLabel htmlFor="cache">캐시</FieldLabel><Select id="cache" name="cache" defaultValue="none"><option value="none">추가 안 함</option><option value="redis">Redis</option><option value="valkey">Valkey</option></Select></Field>
              </div>
              <Alert variant="notice"><ShieldCheckIcon /><AlertTitle>비밀값 보호</AlertTitle><AlertDescription>연결 보안 정보는 서비스 환경 변수에 마스킹된 값으로 연결되며 원문은 콘솔에 표시하지 않습니다.</AlertDescription></Alert>
            </FieldGroup>
          </section>
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-3">
          <div>{stepId === 'project' ? <Link className={buttonVariants({ variant: 'outline' })} href={`/org/${orgSlug}/projects`}>취소</Link> : <Button variant="outline" type="button" onClick={() => setStepId(previousProjectWizardStep(stepId))}><ArrowLeftIcon data-icon="inline-start" />이전</Button>}</div>
          <span className="text-sm tabular-nums text-muted-foreground" aria-live="polite">{step + 1} / {projectWizardSteps.length}</span>
          <div>{!finalStep ? <button type="button" className={buttonVariants()} onClick={handleNextClick} data-wizard-next>다음<ArrowRightIcon data-icon="inline-end" /></button> : <button type="submit" className={buttonVariants()} data-wizard-submit>프로젝트 만들기</button>}</div>
        </CardFooter>
      </Card>
    </form>
  );
}
