'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import type { ServiceRecord } from './types';

type Settings = Readonly<Record<string, unknown>>;

type Snapshot = Readonly<{ serviceId: string; projectId: string; updatedAt: string; deployed: boolean; settings: Settings }>;
type Preview = Readonly<{ diff?: readonly Readonly<{ field?: string; before?: unknown; after?: unknown }>[]; buildPlan?: unknown }>;
type Draft = {
  name: string; type: string; sourceType: string; repoUrl: string; imageUrl: string; branch: string;
  rootDirectory: string; buildContext: string; dockerfilePath: string; installCommand: string; buildCommand: string;
  startCommand: string; outputDirectory: string; port: string; healthCheckPath: string; livenessPath: string;
  readinessPath: string; publicHealthPath: string; requestCpu: string; requestMemory: string; limitCpu: string; limitMemory: string;
};

type Status = 'loading' | 'ready' | 'pending-preview' | 'pending-save' | 'pending-replacement' | 'saved' | 'stale' | 'permission' | 'failed';

const serviceTypes = [['web', '웹'], ['private', '비공개 서비스'], ['worker', '워커'], ['cron', '예약 작업'], ['job', '일회성 작업']] as const;
const sourceTypes = [['github', 'GitHub'], ['gitlab', 'GitLab'], ['zip', 'ZIP'], ['image', '빌드된 이미지'], ['local', '로컬 Dockerfile']] as const;
const mutableFields = ['branch', 'rootDirectory', 'buildContext', 'dockerfilePath', 'installCommand', 'buildCommand', 'startCommand', 'outputDirectory', 'port', 'healthCheckPath', 'livenessPath', 'readinessPath', 'publicHealthPath'] as const;

function asSettings(value: unknown): value is Settings {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotFrom(value: unknown): Snapshot | null {
  const outer = asSettings(value) ? value : null;
  const candidate = asSettings(outer?.snapshot) ? outer.snapshot : outer;
  const settings = asSettings(candidate?.settings) ? candidate.settings : null;
  return typeof candidate?.serviceId === 'string' && typeof candidate?.projectId === 'string' && typeof candidate?.updatedAt === 'string' && typeof candidate?.deployed === 'boolean' && settings
    ? { serviceId: candidate.serviceId, projectId: candidate.projectId, updatedAt: candidate.updatedAt, deployed: candidate.deployed, settings }
    : null;
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function quantity(value: unknown, key: 'cpu' | 'memory'): string {
  return asSettings(value) ? text(value[key]) : '';
}

function draftFrom(settings: Settings): Draft {
  const resources = asSettings(settings.resources) ? settings.resources : null;
  return {
    name: text(settings.name), type: text(settings.type) || 'web', sourceType: text(settings.sourceType) || 'github', repoUrl: text(settings.repoUrl), imageUrl: text(settings.imageUrl ?? settings.image), branch: text(settings.branch),
    rootDirectory: text(settings.rootDirectory), buildContext: text(settings.buildContext), dockerfilePath: text(settings.dockerfilePath), installCommand: text(settings.installCommand), buildCommand: text(settings.buildCommand),
    startCommand: text(settings.startCommand), outputDirectory: text(settings.outputDirectory), port: settings.port === undefined ? '' : String(settings.port), healthCheckPath: text(settings.healthCheckPath), livenessPath: text(settings.livenessPath), readinessPath: text(settings.readinessPath), publicHealthPath: text(settings.publicHealthPath),
    requestCpu: quantity(resources?.requests, 'cpu') || '100m', requestMemory: quantity(resources?.requests, 'memory') || '128Mi', limitCpu: quantity(resources?.limits, 'cpu') || '500m', limitMemory: quantity(resources?.limits, 'memory') || '512Mi',
  };
}

function pathError(value: string): string | null {
  if (!value) return null;
  return /^\/(?!\/)[^\\\s?#\u0000-\u001f\u007f]*$/.test(value) && !value.split('/').some((part) => part === '.' || part === '..') && !/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f|3f|23|25)/i.test(value)
    ? null : '슬래시로 시작하고 공백, query, fragment, 상위 경로 없이 입력하세요.';
}

function quantityError(value: string, kind: 'cpu' | 'memory'): string | null {
  if (kind === 'cpu') return /^(?:\d+(?:\.\d{1,3})?|\d+m)$/.test(value) ? null : 'CPU는 100m 또는 0.5 형식으로 입력하세요.';
  return /^\d+(?:Mi|Gi)$/.test(value) ? null : '메모리는 128Mi 또는 1Gi 형식으로 입력하세요.';
}

function quantityValue(value: string, kind: 'cpu' | 'memory'): number {
  if (kind === 'cpu') return value.endsWith('m') ? Number(value.slice(0, -1)) : Number(value) * 1000;
  return Number(value.slice(0, -2)) * (value.endsWith('Gi') ? 1024 : 1);
}

function validation(draft: Draft): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = '서비스 이름을 입력하세요.';
  if (!/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535) errors.port = '포트는 1에서 65535 사이의 정수여야 합니다.';
  for (const field of ['healthCheckPath', 'livenessPath', 'readinessPath', 'publicHealthPath'] as const) {
    const error = pathError(draft[field]);
    if (error) errors[field] = error;
  }
  if (draft.type !== 'web' && draft.publicHealthPath) errors.publicHealthPath = '공개 상태 경로는 웹 서비스에서만 사용할 수 있습니다.';
  for (const [field, kind] of [['requestCpu', 'cpu'], ['limitCpu', 'cpu'], ['requestMemory', 'memory'], ['limitMemory', 'memory']] as const) {
    const error = quantityError(draft[field], kind);
    if (error) errors[field] = error;
  }
  if (!errors.requestCpu && !errors.limitCpu && quantityValue(draft.requestCpu, 'cpu') > quantityValue(draft.limitCpu, 'cpu')) errors.requestCpu = 'CPU 요청은 제한보다 클 수 없습니다.';
  if (!errors.requestMemory && !errors.limitMemory && quantityValue(draft.requestMemory, 'memory') > quantityValue(draft.limitMemory, 'memory')) errors.requestMemory = '메모리 요청은 제한보다 클 수 없습니다.';
  return errors;
}

function changesFrom(draft: Draft, initial: Draft, deployed: boolean): Readonly<Record<string, unknown>> {
  const changes: Record<string, unknown> = {};
  for (const field of mutableFields) {
    if (draft[field] !== initial[field]) changes[field] = field === 'port' ? Number(draft.port) : draft[field] || null;
  }
  for (const field of ['name', 'type', 'sourceType', 'repoUrl', 'imageUrl'] as const) {
    if (!deployed && draft[field] !== initial[field]) changes[field] = draft[field] || null;
  }
  if (draft.requestCpu !== initial.requestCpu || draft.requestMemory !== initial.requestMemory || draft.limitCpu !== initial.limitCpu || draft.limitMemory !== initial.limitMemory) {
    changes.resources = { requests: { cpu: draft.requestCpu, memory: draft.requestMemory }, limits: { cpu: draft.limitCpu, memory: draft.limitMemory } };
  }
  return changes;
}

function changesKey(changes: Readonly<Record<string, unknown>>): string { return JSON.stringify(changes); }

async function api(path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<Readonly<{ status: number; payload: unknown }>> {
  try {
    const response = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload: unknown = await response.json().catch(() => null);
    return { status: response.status, payload };
  } catch (error) {
    if (error instanceof TypeError) return { status: 0, payload: null };
    throw error;
  }
}

function errorText(payload: unknown): string {
  const record = asSettings(payload) ? payload : null;
  const value = record?.message ?? record?.error;
  return typeof value === 'string' ? value : '요청을 처리하지 못했습니다.';
}

function previewDiff(value: unknown): Preview['diff'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => asSettings(item) ? [{ field: text(item.field) || undefined, before: item.before, after: item.after }] : []);
}

function Diff({ preview }: Readonly<{ preview: Preview }>) {
  const diff = preview.diff ?? [];
  return <Card size="sm"><CardHeader><CardTitle>저장 전 빌드 계획</CardTitle><CardDescription>이 미리보기는 설정 변경만 비교합니다. 배포를 만들거나 과거 스냅샷을 변경하지 않습니다.</CardDescription></CardHeader><CardContent className="flex flex-col gap-raibit-sm">
    {diff.length > 0 ? diff.map((item, index) => <div className="grid gap-raibit-xs border-b border-border pb-raibit-sm last:border-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]" key={`${item.field ?? 'change'}-${index}`}><strong className="font-mono text-caption">{item.field ?? '설정'}</strong><code className="break-words text-code text-muted-foreground">{String(item.before ?? '—')}</code><code className="break-words text-code">{String(item.after ?? '—')}</code></div>) : <p className="text-muted-foreground">빌드 계획에 반영되는 차이가 없습니다.</p>}
    {preview.buildPlan ? <pre className="max-h-64 overflow-auto rounded-sm bg-inverse p-raibit-md text-code text-inverse-foreground">{JSON.stringify(preview.buildPlan, null, 2)}</pre> : null}
  </CardContent></Card>;
}

export function ServiceSettingsForm({ actionBase, service }: Readonly<{ actionBase: string; service: ServiceRecord }>) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<Draft | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [replacementOpen, setReplacementOpen] = useState(false);
  const errors = useMemo(() => draft ? validation(draft) : {}, [draft]);
  const changes = useMemo(() => draft && initial && snapshot ? changesFrom(draft, initial, snapshot.deployed) : {}, [draft, initial, snapshot]);
  const dirty = Object.keys(changes).length > 0;
  const saveAllowed = dirty && Object.keys(errors).length === 0 && previewKey === changesKey(changes) && status !== 'pending-save';

  async function reload(): Promise<void> {
    setStatus('loading'); setMessage(''); setPreview(null); setPreviewKey('');
    const result = await api(actionBase, 'GET');
    const next = snapshotFrom(result.payload);
    if (!next || !result.status.toString().startsWith('2')) { setStatus(result.status === 401 || result.status === 403 ? 'permission' : 'failed'); setMessage(errorText(result.payload)); return; }
    const nextDraft = draftFrom(next.settings); setSnapshot(next); setInitial(nextDraft); setDraft(nextDraft); setStatus('ready');
  }

  useEffect(() => { void reload(); }, [actionBase]);

  function update(field: keyof Draft, value: string): void { setDraft((current) => current ? { ...current, [field]: value } : current); setPreview(null); setPreviewKey(''); if (status === 'saved') setStatus('ready'); }

  async function previewChanges(): Promise<void> {
    if (!snapshot || !dirty || Object.keys(errors).length > 0) return;
    setStatus('pending-preview'); setMessage('');
    const result = await api(`${actionBase}/preview`, 'POST', { expectedUpdatedAt: snapshot.updatedAt, changes });
    if (result.status === 409) { setStatus('stale'); setMessage('다른 변경이 먼저 저장되었습니다. 현재 설정을 다시 불러오세요.'); return; }
    if (!result.status.toString().startsWith('2')) { setStatus(result.status === 401 || result.status === 403 ? 'permission' : 'failed'); setMessage(errorText(result.payload)); return; }
    const payload = asSettings(result.payload) ? result.payload : null; setPreview({ diff: previewDiff(payload?.diff), buildPlan: payload?.buildPlan }); setPreviewKey(changesKey(changes)); setStatus('ready');
  }

  async function save(): Promise<void> {
    if (!snapshot || !saveAllowed) return;
    setStatus('pending-save'); setMessage('');
    const result = await api(actionBase, 'PATCH', { expectedUpdatedAt: snapshot.updatedAt, changes });
    if (result.status === 409) { setStatus('stale'); setMessage('현재 설정이 오래되었습니다. 다시 불러온 뒤 변경을 검토하세요.'); return; }
    const next = snapshotFrom(result.payload);
    if (!result.status.toString().startsWith('2') || !next) { setStatus(result.status === 401 || result.status === 403 ? 'permission' : 'failed'); setMessage(errorText(result.payload)); return; }
    const nextDraft = draftFrom(next.settings); setSnapshot(next); setInitial(nextDraft); setDraft(nextDraft); setPreview(null); setPreviewKey(''); setStatus('saved'); setMessage('설정이 저장되었습니다. 이 작업은 배포를 만들지 않습니다.');
  }

  async function replace(): Promise<void> {
    if (!snapshot || !draft) return;
    setStatus('pending-replacement'); setMessage('');
    const source = { sourceType: draft.sourceType, repoUrl: draft.repoUrl || undefined, image: draft.imageUrl || undefined, imageUrl: draft.imageUrl || undefined };
    const result = await api(`${actionBase}/replacements`, 'POST', { expectedUpdatedAt: snapshot.updatedAt, confirmed: true, name: draft.name, source });
    if (result.status === 409) { setStatus('stale'); setMessage('현재 설정이 오래되었습니다. 교체 전 최신 상태를 다시 확인하세요.'); setReplacementOpen(false); return; }
    if (!result.status.toString().startsWith('2')) { setStatus(result.status === 401 || result.status === 403 ? 'permission' : 'failed'); setMessage(errorText(result.payload)); return; }
    setReplacementOpen(false); setStatus('saved'); setMessage('새 서비스 교체를 만들었습니다. 기존 서비스와 배포 스냅샷은 보존됩니다.');
  }

  if (!draft || !snapshot) return <Card><CardHeader><CardTitle><h2>{service.name || service.slug || '서비스'} 설정</h2></CardTitle><CardDescription>조건부 저장에 필요한 현재 설정을 불러오는 중입니다.</CardDescription></CardHeader><CardContent>{status === 'loading' ? <Spinner /> : <Alert variant={status === 'permission' ? 'destructive' : 'default'}><AlertTitle>{status === 'permission' ? '권한 확인 필요' : '설정을 불러올 수 없습니다.'}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}</CardContent>{status !== 'loading' ? <CardFooter className="justify-end"><Button onClick={() => void reload()} variant="outline">다시 불러오기</Button></CardFooter> : null}</Card>;

  const immutable = snapshot.deployed;
  const busy = status === 'pending-preview' || status === 'pending-save' || status === 'pending-replacement';
  const field = (name: keyof Draft, label: string, options: Readonly<{ type?: 'text' | 'number' | 'url'; disabled?: boolean; help?: string }> = {}) => <Field data-invalid={Boolean(errors[name])} data-disabled={options.disabled}><FieldLabel htmlFor={`service-settings-${name}`}>{label}</FieldLabel><Input aria-invalid={Boolean(errors[name])} disabled={options.disabled || busy} id={`service-settings-${name}`} onChange={(event) => update(name, event.target.value)} type={options.type ?? 'text'} value={draft[name]} />{errors[name] ? <FieldError>{errors[name]}</FieldError> : options.help ? <FieldDescription>{options.help}</FieldDescription> : null}</Field>;
  return <div className="flex flex-col gap-raibit-lg" data-service-settings>
    <Card><CardHeader><CardTitle><h2>{service.name || service.slug || '서비스'} 설정</h2></CardTitle><CardDescription>저장 전에는 결정적 빌드 계획 차이를 검토합니다. 저장만으로 배포가 시작되지는 않습니다.</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-raibit-sm"><Badge variant={dirty ? 'outline' : 'secondary'}>{dirty ? '저장되지 않은 변경' : '저장됨'}</Badge><Badge variant="outline">수정 기준 {snapshot.updatedAt}</Badge>{immutable ? <Badge variant="secondary">첫 배포 이후 식별 정보 잠김</Badge> : <Badge variant="secondary">첫 배포 전 식별 정보 수정 가능</Badge>}</CardContent></Card>
    {status === 'saved' || status === 'stale' || status === 'permission' || status === 'failed' ? <Alert variant={status === 'saved' ? 'notice' : status === 'permission' || status === 'failed' ? 'destructive' : 'default'}><AlertTitle>{status === 'stale' ? '다시 불러오기 필요' : status === 'permission' ? '권한 확인 필요' : status === 'saved' ? '저장 완료' : '요청을 확인하세요'}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert> : null}
    <Card><CardHeader><CardTitle>실행 설정</CardTitle><CardDescription>이름, 유형, 소스는 첫 배포 이후 기존 서비스에서 변경할 수 없습니다.</CardDescription></CardHeader><CardContent><FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-raibit-lg">
      {field('name', '서비스 이름', { disabled: immutable })}
      <Field data-disabled={immutable}><FieldLabel htmlFor="service-settings-type">서비스 유형</FieldLabel><Select disabled={immutable || busy} id="service-settings-type" onChange={(event) => update('type', event.target.value)} value={draft.type}>{serviceTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <Field data-disabled={immutable}><FieldLabel htmlFor="service-settings-source-type">소스 유형</FieldLabel><Select disabled={immutable || busy} id="service-settings-source-type" onChange={(event) => update('sourceType', event.target.value)} value={draft.sourceType}>{sourceTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      {field('repoUrl', '저장소 URL', { disabled: immutable, type: 'url' })}
      {field('imageUrl', '고정 이미지', { disabled: immutable, help: '이미지는 registry/repository@sha256:… digest를 사용하세요.' })}
      {field('branch', '브랜치')}{field('rootDirectory', '루트 경로')}{field('buildContext', '빌드 컨텍스트')}{field('dockerfilePath', 'Dockerfile 경로')}
      {field('installCommand', '설치 명령')}{field('buildCommand', '빌드 명령')}{field('startCommand', '시작 명령')}{field('outputDirectory', '출력 경로')}{field('port', '포트', { type: 'number' })}
    </FieldGroup></CardContent></Card>
    <Card><CardHeader><CardTitle>상태 확인과 리소스</CardTitle><CardDescription>상태 경로는 선택 사항입니다. 환경 변수와 비밀값은 별도의 보안 경로에서 관리합니다.</CardDescription></CardHeader><CardContent className="flex flex-col gap-raibit-xl"><FieldSet><FieldLegend>상태 경로</FieldLegend><FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-raibit-lg">{field('healthCheckPath', '공통 상태 경로', { help: '/healthz 같은 안전한 절대 경로' })}{field('livenessPath', 'Liveness 경로')}{field('readinessPath', 'Readiness 경로')}{field('publicHealthPath', '공개 상태 경로', { disabled: draft.type !== 'web' })}</FieldGroup></FieldSet><Separator /><FieldSet><FieldLegend>CPU와 메모리</FieldLegend><FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-raibit-lg">{field('requestCpu', 'CPU 요청')}{field('limitCpu', 'CPU 제한')}{field('requestMemory', '메모리 요청')}{field('limitMemory', '메모리 제한')}</FieldGroup></FieldSet></CardContent><CardFooter className="justify-end gap-raibit-sm"><Button disabled={busy} onClick={() => void reload()} variant="outline">현재 상태 다시 불러오기</Button><Button disabled={!dirty || Object.keys(errors).length > 0 || busy} onClick={() => void previewChanges()} variant="outline">{status === 'pending-preview' ? <><Spinner data-icon="inline-start" />계획 비교 중</> : '빌드 계획 미리보기'}</Button><Button disabled={!saveAllowed} onClick={() => void save()}>{status === 'pending-save' ? <><Spinner data-icon="inline-start" />저장 중</> : '설정 저장'}</Button></CardFooter></Card>
    {preview ? <Diff preview={preview} /> : null}
    {immutable ? <Card className="border-destructive/25"><CardHeader><CardTitle>소스 교체</CardTitle><CardDescription>기존 서비스, 운영 중인 워크로드 및 모든 배포 스냅샷은 그대로 보존됩니다. 새 서비스를 만들어 소스를 교체합니다.</CardDescription></CardHeader><CardFooter className="justify-end"><Button disabled={busy || Object.keys(errors).length > 0} onClick={() => setReplacementOpen(true)} variant="destructive">새 서비스 교체 만들기</Button></CardFooter></Card> : null}
    <Dialog onOpenChange={setReplacementOpen} open={replacementOpen}><DialogContent><DialogHeader><DialogTitle>새 서비스 교체 만들기</DialogTitle><DialogDescription>기존 서비스는 보존되며, 이 동작은 기존 배포 또는 스냅샷을 수정하지 않습니다.</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setReplacementOpen(false)} variant="outline">취소</Button><Button disabled={busy} onClick={() => void replace()} variant="destructive">{status === 'pending-replacement' ? <><Spinner data-icon="inline-start" />만드는 중</> : '기존 서비스 보존 후 만들기'}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
