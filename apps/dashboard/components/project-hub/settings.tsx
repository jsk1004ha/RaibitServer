'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { apiAction } from '@/lib/api-action';
import type { DashboardLoadIssue } from '@/lib/api';
import type { ProjectHubData, ProjectSettingsView } from './types';

type MutationState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'saved'; updatedAt: string }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'error'; code: string }>;

type DeletionState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'scheduled'; requestedAt: string; status: string }>
  | Readonly<{ kind: 'error'; code: string }>;

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function settingsView(value: unknown): ProjectSettingsView | null {
  const view = record(value);
  const project = record(view?.project);
  const snapshot = record(view?.snapshot);
  const impact = record(view?.deletionImpact);
  const id = text(project?.id);
  const organizationId = text(project?.organizationId);
  const name = text(project?.name);
  const slug = text(project?.slug);
  const description = project?.description === null ? null : text(project?.description);
  const status = text(project?.status);
  const updatedAt = text(project?.updatedAt);
  const deletionRequestedAt = project?.deletionRequestedAt === null ? null : text(project?.deletionRequestedAt);
  const snapshotUpdatedAt = text(snapshot?.updatedAt);
  const services = count(impact?.services);
  const resources = count(impact?.resources);
  const previews = count(impact?.previews);
  if (!id || !organizationId || !name || !slug || (description === null && project?.description !== null) || !status || !updatedAt || (deletionRequestedAt === null && project?.deletionRequestedAt !== null) || !snapshotUpdatedAt || services === null || resources === null || previews === null) return null;
  return { project: { id, organizationId, name, slug, description, status, updatedAt, deletionRequestedAt }, snapshot: { updatedAt: snapshotUpdatedAt }, deletionImpact: { services, resources, previews } };
}

function errorCode(value: unknown, status: number): string {
  const payload = record(value);
  return text(payload?.error) ?? (status === 403 ? 'permission_denied' : status === 409 ? 'STALE_PROJECT' : 'settings_request_failed');
}

function errorMessage(code: string): string {
  if (code === 'permission_denied' || code === 'forbidden') return '이 작업을 수행할 권한이 없습니다.';
  if (code === 'STALE_PROJECT') return '다른 사용자가 이 프로젝트를 변경했습니다.';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
}

function savedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function SettingsView({ data, issue, orgSlug, settings }: Readonly<{ data: ProjectHubData; issue: DashboardLoadIssue | null; orgSlug: string; settings: ProjectSettingsView | null }>) {
  const [snapshot, setSnapshot] = useState<ProjectSettingsView | null>(settingsView(settings));
  const [name, setName] = useState(snapshot?.project.name ?? '');
  const [description, setDescription] = useState(snapshot?.project.description ?? '');
  const [mutation, setMutation] = useState<MutationState>({ kind: 'idle' });
  const [deletion, setDeletion] = useState<DeletionState>({ kind: 'idle' });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);

  useEffect(() => {
    const next = settingsView(settings);
    setSnapshot(next);
    setName(next?.project.name ?? '');
    setDescription(next?.project.description ?? '');
  }, [settings]);

  const dirty = name !== (snapshot?.project.name ?? '') || description !== (snapshot?.project.description ?? '');
  const deletionRequested = snapshot?.project.deletionRequestedAt ?? (deletion.kind === 'scheduled' ? deletion.requestedAt : null);
  const impact = snapshot?.deletionImpact ?? { services: data.services.length, resources: data.resources.length, previews: data.previewDeployments.length };

  if (!snapshot) {
    return <Alert variant="destructive"><AlertTitle>{issue?.status === 403 ? '설정 권한이 없습니다.' : '프로젝트 설정을 불러오지 못했습니다.'}</AlertTitle><AlertDescription>{issue?.message ?? '프로젝트 설정을 불러온 뒤 다시 시도하세요.'}</AlertDescription></Alert>;
  }

  async function saveSettings(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dirty || mutation.kind === 'pending' || deletionRequested) return;
    const currentSnapshot = snapshot;
    if (!currentSnapshot) return;
    setMutation({ kind: 'pending' });
    const input: { expectedUpdatedAt: string; name?: string; description?: string } = { expectedUpdatedAt: currentSnapshot.snapshot.updatedAt };
    if (name !== currentSnapshot.project.name) input.name = name;
    if (description !== (currentSnapshot.project.description ?? '')) input.description = description;
    try {
      const response = await fetch(apiAction(`/projects/${encodeURIComponent(data.projectId)}/settings`), {
        method: 'PATCH', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        const code = errorCode(payload, response.status);
        setMutation(code === 'STALE_PROJECT' ? { kind: 'stale' } : { kind: 'error', code });
        return;
      }
      const next = settingsView(payload);
      if (!next) {
        setMutation({ kind: 'error', code: 'invalid_settings_response' });
        return;
      }
      setSnapshot(next);
      setName(next.project.name);
      setDescription(next.project.description ?? '');
      setMutation({ kind: 'saved', updatedAt: next.snapshot.updatedAt });
    } catch {
      setMutation({ kind: 'error', code: 'settings_request_unavailable' });
    }
  }

  function reloadSettings(): void {
    window.location.assign(`/org/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(data.projectId)}?view=settings`);
  }

  async function requestDeletion(): Promise<void> {
    if (!deleteConfirmed || deletion.kind === 'pending') return;
    setDeletion({ kind: 'pending' });
    try {
      const response = await fetch(apiAction(`/projects/${encodeURIComponent(data.projectId)}/settings/deletion`), {
        method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        setDeletion({ kind: 'error', code: errorCode(payload, response.status) });
        return;
      }
      const scheduled = record(payload);
      const requestedAt = text(scheduled?.deletionRequestedAt);
      const status = text(scheduled?.status);
      if (!requestedAt || !status || scheduled?.scheduled !== true) {
        setDeletion({ kind: 'error', code: 'invalid_deletion_response' });
        return;
      }
      setDeletion({ kind: 'scheduled', requestedAt, status });
      setDeleteDialogOpen(false);
    } catch {
      setDeletion({ kind: 'error', code: 'deletion_request_unavailable' });
    }
  }

  return (
    <div className="flex flex-col gap-raibit-xl">
      <Card>
        <CardHeader><CardTitle><h2>프로젝트 일반 설정</h2></CardTitle><CardDescription>이름과 설명만 변경할 수 있습니다. URL, 조직, 수명 주기 상태는 여기서 변경할 수 없습니다.</CardDescription></CardHeader>
        <form onSubmit={saveSettings}>
          <CardContent><FieldGroup><Field><FieldLabel htmlFor="project-name">프로젝트 이름</FieldLabel><Input autoComplete="off" disabled={Boolean(deletionRequested)} id="project-name" maxLength={120} name="name" onChange={(event) => setName(event.target.value)} required value={name} /></Field><Field><FieldLabel htmlFor="project-description">설명</FieldLabel><Textarea disabled={Boolean(deletionRequested)} id="project-description" maxLength={2_000} name="description" onChange={(event) => setDescription(event.target.value)} value={description} /><FieldDescription>서비스 목적과 운영 맥락을 팀에 공유하세요.</FieldDescription></Field></FieldGroup></CardContent>
          <CardFooter className="flex flex-wrap justify-between gap-raibit-md"><div aria-atomic="true" aria-live="polite">{mutation.kind === 'saved' ? <span className="text-caption text-muted-foreground">{savedAt(mutation.updatedAt)}에 저장됨</span> : null}</div><Button disabled={!dirty || mutation.kind === 'pending' || Boolean(deletionRequested)} type="submit">{mutation.kind === 'pending' ? <><Spinner data-icon="inline-start" />저장 중</> : '변경 사항 저장'}</Button></CardFooter>
        </form>
        {mutation.kind === 'stale' ? <CardContent><Alert variant="destructive"><AlertTitle>저장된 설정이 최신이 아닙니다.</AlertTitle><AlertDescription>내 변경: 이름 {name === snapshot.project.name ? '없음' : '수정됨'}, 설명 {description === (snapshot.project.description ?? '') ? '없음' : '수정됨'}. 최신 설정을 불러온 후 차이를 다시 검토하세요.</AlertDescription><Button className="mt-raibit-sm" onClick={reloadSettings} type="button" variant="outline">최신 설정 불러오기</Button></Alert></CardContent> : null}
        {mutation.kind === 'error' ? <CardContent><Alert variant="destructive"><AlertTitle>설정을 저장하지 못했습니다.</AlertTitle><AlertDescription>{errorMessage(mutation.code)}</AlertDescription></Alert></CardContent> : null}
      </Card>

      <Card className="border-destructive/25">
        <CardHeader><CardTitle><h2>프로젝트 삭제</h2></CardTitle><CardDescription>삭제 요청은 작업 대기열에 등록됩니다. 이 화면에서 서비스나 리소스를 즉시 삭제하지 않습니다.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-raibit-lg"><FieldGroup><Field orientation="responsive"><FieldLabel htmlFor="project-url">프로젝트 URL</FieldLabel><Input aria-readonly="true" id="project-url" readOnly value={snapshot.project.slug} /></Field><Field orientation="responsive"><FieldLabel htmlFor="project-organization">조직</FieldLabel><Input aria-readonly="true" id="project-organization" readOnly value={snapshot.project.organizationId} /></Field><Field orientation="responsive"><FieldLabel>상태</FieldLabel><Badge variant="outline">{snapshot.project.status}</Badge></Field></FieldGroup><Alert><AlertTitle>삭제 영향</AlertTitle><AlertDescription>서비스 {impact.services}개 · 리소스 {impact.resources}개 · 미리보기 {impact.previews}개</AlertDescription></Alert>{deletionRequested ? <Alert variant="notice"><AlertTitle>삭제 요청이 대기열에 등록되었습니다.</AlertTitle><AlertDescription>{savedAt(deletionRequested)}부터 조정기가 삭제를 처리합니다. 현재 상태: {deletion.kind === 'scheduled' ? deletion.status : snapshot.project.status}</AlertDescription></Alert> : null}{deletion.kind === 'error' ? <Alert variant="destructive"><AlertTitle>삭제 요청을 등록하지 못했습니다.</AlertTitle><AlertDescription>{errorMessage(deletion.code)}</AlertDescription></Alert> : null}</CardContent>
        <CardFooter className="justify-end"><Dialog onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen}><DialogTrigger render={<Button disabled={Boolean(deletionRequested)} type="button" variant="destructive" />}>삭제 요청</DialogTrigger><DialogContent><DialogHeader><DialogTitle>프로젝트 삭제를 요청할까요?</DialogTitle><DialogDescription>서비스 {impact.services}개, 리소스 {impact.resources}개, 미리보기 {impact.previews}개가 삭제 조정 대상이 됩니다. 이 요청은 대기열에 등록되며 즉시 삭제되지 않습니다.</DialogDescription></DialogHeader><FieldSet><FieldLegend variant="label">삭제 확인</FieldLegend><Field orientation="horizontal"><Checkbox checked={deleteConfirmed} id="project-delete-confirmed" onCheckedChange={setDeleteConfirmed} /><FieldLabel htmlFor="project-delete-confirmed">영향과 복구 절차를 확인했습니다.</FieldLabel></Field></FieldSet><DialogFooter><Button disabled={!deleteConfirmed || deletion.kind === 'pending'} onClick={requestDeletion} type="button" variant="destructive">{deletion.kind === 'pending' ? <><Spinner data-icon="inline-start" />요청 등록 중</> : '삭제 요청 등록'}</Button></DialogFooter></DialogContent></Dialog></CardFooter>
      </Card>
    </div>
  );
}
