'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  TemplateInstallationListResponseSchema, TemplateInstallationResponseSchema, TemplatePreflightResponseSchema,
  type EnvironmentView, type TemplateCatalogResponse, type TemplateInstallationResponse, type TemplateInstallRequest, type TemplatePreflightResponse,
} from '@raibitserver/schemas';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { apiAction } from '@/lib/api-action';
import { createBrowserIdempotencyKey } from '@/lib/recovery-idempotency';
import { HubEmpty } from './shared';

type Props = Readonly<{
  base: string;
  projectId: string;
  deletionPending: boolean;
  catalog: TemplateCatalogResponse | null;
  environments: readonly EnvironmentView[];
  installations: readonly TemplateInstallationResponse[];
  installationsLoaded: boolean;
}>;

const templateCopy: Record<string, { title: string; description: string }> = {
  'next-postgres': { title: 'Next.js + PostgreSQL', description: '웹 애플리케이션과 데이터를 저장할 PostgreSQL을 함께 시작합니다.' },
  fastapi: { title: 'FastAPI', description: 'Python API 서버를 웹 서비스로 배포합니다.' },
  'discord-bot': { title: 'Discord 봇', description: '공개 웹 주소 없이 백그라운드 워커로 봇을 실행합니다.' },
};
const statusLabels = { provisioning: '리소스 준비 중', building: '빌드 및 배포 중', failed: '설치 실패', ready: '배포 완료' } as const;
const errors: Record<string, string> = {
  TEMPLATE_SLUG_CONFLICT: '같은 환경에 동일한 이름의 서비스 또는 리소스가 있습니다. 기존 구성을 확인하거나 다른 환경을 선택하세요.',
  TEMPLATE_CAPACITY_EXCEEDED: '이 구성에 필요한 프로젝트 한도가 부족합니다. 사용량을 확인해 주세요.',
  TEMPLATE_RESOURCE_UNSUPPORTED: '현재 환경에서 이 리소스를 설치할 수 없습니다.',
  TEMPLATE_UNAVAILABLE: '템플릿 설치가 아직 활성화되지 않았습니다. 운영자의 활성화 후 설치할 수 있습니다.',
  TEMPLATE_CATALOG_DIGEST_MISMATCH: '템플릿 목록이 변경되었습니다. 페이지를 새로고침한 뒤 구성을 다시 확인하세요.',
  TEMPLATE_SOURCE_DIGEST_MISMATCH: '템플릿 소스가 변경되었습니다. 페이지를 새로고침한 뒤 구성을 다시 확인하세요.',
  TEMPLATE_VERSION_CONFLICT: '설치 상태가 변경되었습니다. 설치 상태를 새로고침한 뒤 다시 시도하세요.',
  TEMPLATE_REQUIRED_INPUT_MISSING: '필수 입력값을 모두 입력하세요.',
  TEMPLATE_INPUT_INVALID: '입력값을 확인하세요. 비밀값에는 줄바꿈을 포함할 수 없습니다.',
  TEMPLATE_NOT_FOUND: '요청한 템플릿이나 설치를 찾을 수 없습니다. 목록을 새로고침해 주세요.',
  TEMPLATE_PROTOCOL_REQUIRED: '현재 서버에서는 이 설치 요청을 처리할 수 없습니다. 운영자에게 문의하세요.',
  TEMPLATE_FORBIDDEN: '템플릿을 설치할 권한이 없습니다.',
};

async function templateRequest<T>(path: string, schema: { parse(value: unknown): T }, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(apiAction(path), {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json().catch(() => { throw new Error('서버 응답을 확인하지 못했습니다. 설치 상태를 새로고침한 뒤 다시 시도하세요.'); });
  if (!response.ok) {
    const code = value && typeof value === 'object' && 'error' in value ? String(value.error) : '';
    throw new Error(errors[code] || (response.status === 401 ? '로그인이 필요하거나 세션이 만료되었습니다.' : response.status === 403 ? '템플릿을 설치할 권한이 없습니다.' : response.status >= 500 ? '요청 결과를 확인하지 못했습니다. 같은 입력으로 다시 시도하거나 설치 내역을 새로고침하세요.' : '요청을 처리하지 못했습니다. 입력과 현재 설치 상태를 확인하세요.'));
  }
  try { return schema.parse(value); } catch { throw new Error('서버 응답을 확인하지 못했습니다. 설치 내역을 새로고침한 뒤 같은 입력으로 다시 시도하세요.'); }
}

export function TemplatesView({ base, projectId, deletionPending, catalog, environments, installations: initialInstallations, installationsLoaded }: Props) {
  const [hydrated, setHydrated] = useState(false);
  const [environmentId, setEnvironmentId] = useState(environments.find((environment) => environment.kind === 'prod')?.id || '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<TemplatePreflightResponse | null>(null);
  const [installations, setInstallations] = useState(initialInstallations);
  const [loaded, setLoaded] = useState(installationsLoaded);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const mutation = useRef<AbortController | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const installKey = useRef<string | null>(null);
  const retryKeys = useRef(new Map<string, { version: number; key: string }>());
  const selected = catalog?.starters.find((starter) => starter.id === selectedId);
  const environment = environments.find((candidate) => candidate.id === environmentId);
  const enabled = hydrated && catalog?.availability.enabled === true && !deletionPending && Boolean(environment);
  const pending = installations.some((row) => row.progress.status === 'building' || row.progress.status === 'provisioning');
  const query = `?environmentId=${encodeURIComponent(environmentId)}`;
  const installationsPath = `/projects/${encodeURIComponent(projectId)}/template-installations`;

  const reload = useCallback(async () => {
    if (!environmentId || (listRequest.current && !listRequest.current.signal.aborted)) return;
    const controller = new AbortController();
    listRequest.current = controller;
    setRefreshing(true);
    try {
      const result = await templateRequest(`${installationsPath}?environmentId=${encodeURIComponent(environmentId)}`, TemplateInstallationListResponseSchema, controller.signal);
      if (controller.signal.aborted) return;
      setInstallations(result.installations);
      setLoaded(true);
      setListError(null);
    } catch {
      if (!controller.signal.aborted) setListError('설치 상태를 불러오지 못했습니다. 마지막으로 확인한 상태를 표시합니다.');
    } finally {
      if (listRequest.current === controller) { listRequest.current = null; setRefreshing(false); }
    }
  }, [environmentId, installationsPath]);

  useEffect(() => {
    void reload();
    return () => listRequest.current?.abort();
  }, [reload]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void reload(), 5_000);
    return () => clearInterval(timer);
  }, [pending, reload]);
  useEffect(() => {
    // Native controls must wait for their handlers before accepting an environment choice.
    setHydrated(true);
    const clear = () => { form.current?.reset(); installKey.current = null; };
    window.addEventListener('pagehide', clear);
    return () => { window.removeEventListener('pagehide', clear); clear(); mutation.current?.abort(); };
  }, []);

  function clearSelection() {
    mutation.current?.abort();
    mutation.current = null;
    setBusy(null);
    form.current?.reset();
    installKey.current = null;
    setSelectedId(null);
    setPreview(null);
    setError(null);
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !catalog || !enabled || mutation.current) return;
    const formData = new FormData(event.currentTarget);
    const inputs = Object.fromEntries(selected.inputs.map((input) => [input.key, String(formData.get(input.key) || '')]));
    installKey.current ??= createBrowserIdempotencyKey('template');
    const body: TemplateInstallRequest = { requiredProtocolVersion: 2, catalogId: selected.id, catalogVersion: selected.version, catalogDigest: catalog.catalogDigest, sourceDigest: selected.source.digest, requestIdempotencyKey: installKey.current, inputs };
    const controller = new AbortController();
    mutation.current = controller;
    const installing = preview !== null;
    setBusy(installing ? 'install' : 'preview');
    setError(null);
    setNotice(null);
    try {
      if (installing) {
        const result = await templateRequest(`${installationsPath}${query}`, TemplateInstallationResponseSchema, controller.signal, body);
        if (controller.signal.aborted) return;
        setInstallations((rows) => [result, ...rows.filter((row) => row.installation.id !== result.installation.id)]);
        setLoaded(true);
        form.current?.reset();
        installKey.current = null;
        setPreview(null);
        setNotice('설치 요청이 접수되었습니다. 아래에서 실제 배포 상태를 확인하세요.');
      } else {
        const result = await templateRequest(`${installationsPath}/preflight${query}`, TemplatePreflightResponseSchema, controller.signal, body);
        if (!controller.signal.aborted) setPreview(result);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof TypeError ? '요청 결과를 확인하지 못했습니다. 같은 입력으로 다시 시도하거나 설치 내역을 새로고침하세요.' : failure instanceof Error ? failure.message : '요청을 처리하지 못했습니다.');
    } finally {
      if (mutation.current === controller) { mutation.current = null; setBusy(null); }
    }
  }

  async function retry(row: TemplateInstallationResponse) {
    if (mutation.current || !enabled) return;
    const installation = row.installation;
    let intent = retryKeys.current.get(installation.id);
    if (!intent || intent.version !== installation.version) {
      intent = { version: installation.version, key: createBrowserIdempotencyKey('template-retry') };
      retryKeys.current.set(installation.id, intent);
    }
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(installation.id);
    setError(null);
    try {
      const result = await templateRequest(`/template-installations/${encodeURIComponent(installation.id)}/retry${query}`, TemplateInstallationResponseSchema, controller.signal, { requiredProtocolVersion: 2, expectedVersion: intent.version, requestIdempotencyKey: intent.key });
      if (controller.signal.aborted) return;
      retryKeys.current.delete(installation.id);
      setInstallations((rows) => rows.map((candidate) => candidate.installation.id === installation.id ? result : candidate));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof TypeError ? '재시도 결과를 확인하지 못했습니다. 설치 상태를 새로고침하거나 다시 시도하세요.' : failure instanceof Error ? failure.message : '다시 시도하지 못했습니다.');
    } finally {
      if (mutation.current === controller) { mutation.current = null; setBusy(null); }
    }
  }

  return <section className="flex min-w-0 flex-col gap-raibit-xl" aria-label="템플릿 설치" data-testid="templates-view">
    <div className="flex flex-col gap-raibit-sm"><h2 className="text-heading-lg">템플릿</h2><p className="text-muted-foreground">필요한 구성을 선택하고 입력값을 확인한 뒤 이 프로젝트에 설치하세요.</p></div>
    {!catalog ? <HubEmpty title="템플릿 목록을 불러오지 못했습니다." description="페이지를 새로고침하여 다시 시도하세요." /> : null}
    {catalog && !catalog.availability.enabled ? <Alert><AlertTitle>템플릿 설치 준비 중</AlertTitle><AlertDescription>{errors.TEMPLATE_UNAVAILABLE}</AlertDescription></Alert> : null}
    {deletionPending ? <Alert><AlertTitle>프로젝트 삭제 진행 중</AlertTitle><AlertDescription>삭제 중인 프로젝트에는 템플릿을 설치할 수 없습니다.</AlertDescription></Alert> : null}
    <FieldGroup><Field data-disabled={!hydrated || environments.length === 0 || undefined}><FieldLabel htmlFor="template-environment">설치 환경</FieldLabel><Select id="template-environment" value={environmentId} disabled={!hydrated || environments.length === 0} onChange={(event) => {
      clearSelection(); setEnvironmentId(event.target.value); setInstallations([]); setLoaded(false); setListError(null);
    }}>{environments.length === 0 ? <option value="">사용 가능한 환경 없음</option> : null}{environments.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.kind === 'prod' ? '운영 (prod)' : '개발 (dev)'}</option>)}</Select><FieldDescription>이미 존재하는 환경에 설치합니다. 서비스와 리소스는 선택한 환경에 함께 생성됩니다.</FieldDescription></Field></FieldGroup>
    <div className="grid min-w-0 gap-raibit-lg md:grid-cols-3">
      {catalog?.starters.map((starter) => <Card key={starter.id} data-testid={`template-card-${starter.id}`}>
        <CardHeader><CardTitle><h3>{templateCopy[starter.id]?.title || starter.id}</h3></CardTitle><CardDescription>{templateCopy[starter.id]?.description || '준비된 서비스 구성을 설치합니다.'}</CardDescription></CardHeader>
        <CardContent className="flex flex-1 flex-col gap-raibit-md"><Configuration services={starter.graph.services} resources={starter.graph.resources} /><p className="text-caption text-muted-foreground">버전 {starter.version}{starter.inputs.length > 0 ? ` · 필수 입력 ${starter.inputs.map((input) => input.key).join(', ')}` : ' · 추가 비밀값 입력 없음'}</p></CardContent>
        <CardFooter><Button variant="outline" disabled={!enabled || Boolean(busy)} onClick={() => { clearSelection(); setSelectedId(starter.id); }}>설치 준비<span className="sr-only"> — {templateCopy[starter.id]?.title || starter.id}</span></Button></CardFooter>
      </Card>)}
    </div>
    {error ? <Alert variant="destructive" aria-live="assertive"><AlertTitle>요청을 완료하지 못했습니다.</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <Alert aria-live="polite"><AlertTitle>설치 요청 접수</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
    {selected ? <Card>
      <CardHeader><CardTitle><h2>{templateCopy[selected.id]?.title || selected.id} 설치</h2></CardTitle><CardDescription>1. 필수 입력 → 2. 구성 확인 → 3. 설치 및 배포</CardDescription></CardHeader>
      <form ref={form} method="post" action={apiAction(`${installationsPath}/preflight${query}`)} onSubmit={(event) => void submit(event)} onChange={() => { installKey.current = null; setPreview(null); setError(null); setNotice(null); }} aria-busy={Boolean(busy)}>
        <CardContent className="flex flex-col gap-raibit-lg">
          <FieldGroup>{selected.inputs.map((input) => <Field key={input.key} data-disabled={Boolean(busy) || undefined}><FieldLabel htmlFor={`template-input-${input.key}`}>{input.key}</FieldLabel><Input id={`template-input-${input.key}`} name={input.key} type="password" autoComplete="new-password" spellCheck={false} required={input.required} maxLength={16384} disabled={Boolean(busy)} aria-describedby={`template-help-${input.key}`} /><FieldDescription id={`template-help-${input.key}`}>설치에 필요한 비밀값입니다. 설치 요청이 접수되거나 템플릿·환경을 바꾸면 입력을 비웁니다.</FieldDescription></Field>)}</FieldGroup>
          {selected.inputs.length === 0 ? <p className="text-muted-foreground">추가 입력값이 없습니다. 생성할 구성을 확인하세요.</p> : null}
          {preview ? <section aria-label="생성할 구성" className="flex flex-col gap-raibit-md"><h3 className="text-heading-md">생성할 구성</h3><p className="text-muted-foreground">{preview.environmentKind === 'prod' ? '운영 (prod)' : '개발 (dev)'} 환경 · 이름 충돌과 사용 가능 여부를 확인했습니다.</p><Configuration services={preview.services} resources={preview.resources} /><p className="text-caption text-muted-foreground">설치 후 리소스 준비, 이미지 빌드와 배포가 이어집니다. 실제 완료 여부는 설치 내역에서 확인할 수 있습니다.</p></section> : null}
        </CardContent>
        <CardFooter className="mt-raibit-lg flex-wrap justify-end gap-raibit-sm"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={clearSelection}>취소</Button><Button type="submit" disabled={!enabled || Boolean(busy)}>{busy === 'install' || busy === 'preview' ? <Spinner data-icon="inline-start" /> : null}{busy === 'install' ? '설치 요청 중' : busy === 'preview' ? '구성 확인 중' : preview ? '설치 및 배포' : '구성 확인'}</Button>{busy ? <Button type="button" variant="outline" onClick={() => { mutation.current?.abort(); mutation.current = null; setBusy(null); setError('응답 대기를 중단했습니다. 서버 작업은 계속될 수 있습니다. 같은 입력으로 다시 시도하거나 설치 상태를 새로고침하세요.'); }}>대기 중단</Button> : null}</CardFooter>
      </form>
    </Card> : null}
    <section aria-labelledby="template-installations-title" className="flex min-w-0 flex-col gap-raibit-lg">
      <div className="flex flex-wrap items-center justify-between gap-raibit-md"><h2 id="template-installations-title" className="text-heading-lg">설치 내역</h2><Button variant="outline" disabled={!hydrated || refreshing || !environmentId} onClick={() => void reload()}>{refreshing ? <Spinner data-icon="inline-start" /> : null}설치 상태 새로고침</Button></div>
      {listError ? <Alert variant="destructive" aria-live="polite"><AlertTitle>설치 상태 확인 필요</AlertTitle><AlertDescription>{listError}</AlertDescription></Alert> : null}
      {!loaded && !listError && environmentId ? <p role="status" className="text-muted-foreground">설치 내역을 확인하고 있습니다.</p> : null}
      {loaded && installations.length === 0 ? <HubEmpty title="이 환경에 설치한 템플릿이 없습니다." description="위에서 템플릿을 선택해 첫 구성을 설치하세요." /> : null}
      {installations.map((row) => <Card key={row.installation.id} data-testid={`template-installation-${row.installation.id}`}>
        <CardHeader><CardTitle><h3>{templateCopy[row.installation.catalogId]?.title || row.installation.catalogId}</h3></CardTitle><CardDescription>{row.installation.environmentKind === 'prod' ? '운영 (prod)' : '개발 (dev)'} · 템플릿 {row.installation.catalogVersion} · 설치 버전 {row.installation.version}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-raibit-md"><div className="flex flex-wrap items-center gap-raibit-sm" aria-live="polite"><Badge variant={row.progress.status === 'failed' ? 'destructive' : 'secondary'}>{statusLabels[row.progress.status]}</Badge><span>{row.progress.completed} / {row.progress.total} 단계 완료</span></div><Configuration services={row.services} resources={row.resources} />{row.progress.status === 'failed' ? <p className="text-muted-foreground">배포 상세에서 실패 원인을 확인한 뒤 다시 시도하세요.</p> : null}</CardContent>
        <CardFooter className="flex-wrap gap-raibit-sm">{row.services.map((service) => <a className={buttonVariants({ variant: 'outline' })} key={service.id} href={`${base}/deployments/${encodeURIComponent(service.deploymentId)}?environmentId=${encodeURIComponent(row.installation.environmentId)}`}>배포 상세<span className="sr-only"> — {service.logicalSlug}</span></a>)}{row.progress.status === 'failed' ? <Button disabled={!enabled || Boolean(busy)} onClick={() => void retry(row)}>{busy === row.installation.id ? <Spinner data-icon="inline-start" /> : null}다시 시도</Button> : null}</CardFooter>
      </Card>)}
    </section>
  </section>;
}

function Configuration({ services, resources }: Pick<TemplatePreflightResponse, 'services' | 'resources'>) {
  return <div className="flex min-w-0 flex-col gap-raibit-sm"><ul className="flex flex-col gap-raibit-sm">{services.map((service) => <li className="break-words [overflow-wrap:anywhere]" key={service.logicalSlug}><strong className="font-medium">{service.logicalSlug}</strong> · {service.type === 'worker' ? '워커 · 공개 주소 없음' : service.type === 'web' ? '웹 서비스 · 공개 주소 제공' : service.type}</li>)}{resources.map((resource) => <li className="break-words [overflow-wrap:anywhere]" key={resource.logicalSlug}><strong className="font-medium">{resource.logicalSlug}</strong> · {resource.engine} · {resource.plan}</li>)}</ul>{resources.length === 0 ? <p className="text-caption text-muted-foreground">추가 관리형 리소스 없음</p> : null}</div>;
}
