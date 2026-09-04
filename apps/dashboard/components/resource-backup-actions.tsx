'use client';

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { ResourceBackupViewSchema, ResourceRestoreViewSchema } from '@raibitserver/schemas';
import type { ResourceBackupView, ResourceRestoreView } from '@raibitserver/schemas';
import { createBrowserIdempotencyKey, isRecoverableAt, resolveRecoveryIntent } from '@/lib/recovery-idempotency';
import type { RecoveryIntent } from '@/lib/recovery-idempotency';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type MutationState =
  | Readonly<{ readonly kind: 'idle' }>
  | Readonly<{ readonly kind: 'pending'; readonly target: string }>
  | Readonly<{ readonly kind: 'success'; readonly message: string }>
  | Readonly<{ readonly kind: 'error'; readonly code: string }>;

type PublicBackupList = Readonly<{ readonly backups: readonly ResourceBackupView[]; readonly nextCursor: string | null }>;

const terminalStatuses = new Set(['READY', 'FAILED', 'EXPIRED', 'DELETED']);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRequestCode(value: unknown): string {
  const record = asRecord(value);
  const error = asRecord(record?.error);
  const candidate = error?.code ?? record?.code ?? record?.error;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate) ? candidate : 'recovery_request_failed';
}

function parseBackupList(value: unknown): PublicBackupList | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.backups)) return null;
  const backups = record.backups.map((entry) => ResourceBackupViewSchema.safeParse(entry));
  if (backups.some((entry) => !entry.success)) return null;
  const cursor = typeof record.nextCursor === 'string' ? record.nextCursor : null;
  return { backups: backups.flatMap((entry) => entry.success ? [entry.data] : []), nextCursor: cursor };
}

function statusProgress(status: string): number {
  switch (status.toUpperCase()) {
    case 'QUEUED': return 15;
    case 'RUNNING': return 55;
    case 'VERIFYING': return 85;
    case 'DELETING': return 75;
    default: return 100;
  }
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'READY') return 'default';
  if (status === 'FAILED' || status === 'EXPIRED') return 'destructive';
  if (status === 'DELETED') return 'outline';
  return 'secondary';
}

function dateLabel(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

async function jsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error) return null;
    return null;
  }
}

function upsertBackup(backups: readonly ResourceBackupView[], next: ResourceBackupView): readonly ResourceBackupView[] {
  const existing = backups.findIndex((backup) => backup.id === next.id);
  if (existing < 0) return [next, ...backups];
  return backups.map((backup) => backup.id === next.id ? next : backup);
}

export function ResourceBackupActions({
  createAction,
  initialCreateKey,
  initialBackups,
  initialLoadFailed,
  initialRestoreKeys,
  listAction,
  returnTo,
}: Readonly<{
  readonly createAction: string;
  readonly initialCreateKey: string;
  readonly initialBackups: readonly ResourceBackupView[];
  readonly initialLoadFailed: boolean;
  readonly initialRestoreKeys: Readonly<Record<string, string>>;
  readonly listAction: string;
  readonly returnTo: string;
}>) {
  const [backupIntent, setBackupIntent] = useState<RecoveryIntent>({ key: initialCreateKey, payload: 'backup-v1' });
  const [backups, setBackups] = useState<readonly ResourceBackupView[]>(initialBackups);
  const [restoreKeys, setRestoreKeys] = useState<Readonly<Record<string, string>>>(initialRestoreKeys);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [state, setState] = useState<MutationState>({ kind: 'idle' });
  const hasActiveBackup = backups.some((backup) => !terminalStatuses.has(backup.status));

  useEffect(() => {
    if (!hasActiveBackup) return undefined;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      setIsRefreshing(true);
      try {
        const response = await fetch(listAction, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
        const payload = response.ok ? parseBackupList(await jsonPayload(response)) : null;
        if (!cancelled && payload) setBackups(payload.backups);
      } catch (error) {
        if (error instanceof Error) return;
        return;
      } finally {
        if (!cancelled) setIsRefreshing(false);
      }
    };
    const interval = window.setInterval(() => { void refresh(); }, 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [hasActiveBackup, listAction]);

  async function submitBackup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state.kind === 'pending') return;
    const intent = resolveRecoveryIntent(backupIntent, 'backup-v1', 'backup', createBrowserIdempotencyKey);
    if (intent !== backupIntent) setBackupIntent(intent);
    setState({ kind: 'pending', target: 'backup' });
    try {
      const response = await fetch(createAction, {
        method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ requestIdempotencyKey: intent.key, formatVersion: 1 }),
      });
      const payload = await jsonPayload(response);
      const parsed = response.ok ? ResourceBackupViewSchema.safeParse(payload) : null;
      if (!parsed || !parsed.success) {
        setState({ kind: 'error', code: safeRequestCode(payload) });
        return;
      }
      setBackups((current) => upsertBackup(current, parsed.data));
      setRestoreKeys((current) => ({ ...current, [parsed.data.id]: createBrowserIdempotencyKey('restore') }));
      setBackupIntent({ key: createBrowserIdempotencyKey('backup'), payload: 'backup-v1' });
      setState({ kind: 'success', message: '백업 요청을 접수했습니다. 진행 상태를 이 화면에서 확인할 수 있습니다.' });
    } catch (error) {
      if (error instanceof Error) {
        setState({ kind: 'error', code: 'recovery_request_unavailable' });
        return;
      }
      setState({ kind: 'error', code: 'recovery_request_unavailable' });
    }
  }

  return (
    <section aria-labelledby="backups-heading" className="flex min-w-0 flex-col gap-4" data-testid="backup-history">
      <Card>
        <CardHeader className="border-b">
          <CardTitle><h2 id="backups-heading">백업</h2></CardTitle>
          <CardDescription>복구 지점은 준비 완료 후에만 새 리소스로 복원할 수 있습니다.</CardDescription>
          <CardAction>
            <form action={createAction} method="post" onSubmit={submitBackup}>
              <input name="_returnTo" type="hidden" value={returnTo} />
              <input name="requestIdempotencyKey" type="hidden" value={backupIntent.key} />
              <input name="formatVersion" type="hidden" value="1" />
              <Button disabled={state.kind === 'pending'} type="submit">{state.kind === 'pending' && state.target === 'backup' ? '요청 중' : '백업 만들기'}</Button>
            </form>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4 pt-6">
          <section aria-atomic="true" aria-live="polite" className="flex min-w-0 flex-col gap-2">
            {state.kind === 'pending' ? <p role="status" className="text-sm text-muted-foreground">복구 작업을 요청하고 있습니다.</p> : null}
            {state.kind === 'success' ? <Alert variant="notice"><AlertTitle>요청을 접수했습니다.</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
            {state.kind === 'error' ? <Alert variant="destructive"><AlertTitle>복구 작업을 요청하지 못했습니다.</AlertTitle><AlertDescription>현재 상태를 확인한 뒤 다시 시도하세요.<span className="block font-mono text-xs">{state.code}</span></AlertDescription></Alert> : null}
          </section>
          {initialLoadFailed ? <Alert><AlertTitle>백업 목록을 일부 불러오지 못했습니다.</AlertTitle><AlertDescription>기존 복구 지점의 상태가 최신이 아닐 수 있습니다. 잠시 후 다시 확인하세요.</AlertDescription></Alert> : null}
          {isRefreshing ? <div className="flex flex-col gap-2" aria-label="백업 상태 갱신 중"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div> : null}
          {backups.length === 0 ? <Empty><EmptyHeader><EmptyTitle>복구 지점이 없습니다.</EmptyTitle><EmptyDescription>백업을 만들면 이 리소스의 복구 지점과 만료 시간이 여기에 표시됩니다.</EmptyDescription></EmptyHeader></Empty> : <BackupHistory backups={backups} initialRestoreKeys={restoreKeys} returnTo={returnTo} onMutation={setState} onBackup={setBackups} />}
        </CardContent>
      </Card>
    </section>
  );
}

function BackupHistory({ backups, initialRestoreKeys, onBackup, onMutation, returnTo }: Readonly<{
  readonly backups: readonly ResourceBackupView[];
  readonly initialRestoreKeys: Readonly<Record<string, string>>;
  readonly onBackup: (updater: (backups: readonly ResourceBackupView[]) => readonly ResourceBackupView[]) => void;
  readonly onMutation: (state: MutationState) => void;
  readonly returnTo: string;
}>) {
  return (
    <>
      <div className="hidden min-w-0 md:block"><Table><TableHeader><TableRow><TableHead>생성 시각</TableHead><TableHead>상태</TableHead><TableHead>크기</TableHead><TableHead>만료</TableHead><TableHead className="text-right">작업</TableHead></TableRow></TableHeader><TableBody>{backups.map((backup) => <BackupRow backup={backup} initialRestoreKey={initialRestoreKeys[backup.id]} key={backup.id} returnTo={returnTo} onBackup={onBackup} onMutation={onMutation} />)}</TableBody></Table></div>
      <div className="flex flex-col gap-3 md:hidden">{backups.map((backup) => <BackupMobileRow backup={backup} initialRestoreKey={initialRestoreKeys[backup.id]} key={backup.id} returnTo={returnTo} onBackup={onBackup} onMutation={onMutation} />)}</div>
    </>
  );
}

function BackupRow({ backup, initialRestoreKey, onBackup, onMutation, returnTo }: Readonly<{
  readonly backup: ResourceBackupView;
  readonly initialRestoreKey: string;
  readonly onBackup: (updater: (backups: readonly ResourceBackupView[]) => readonly ResourceBackupView[]) => void;
  readonly onMutation: (state: MutationState) => void;
  readonly returnTo: string;
}>) {
  return <TableRow data-testid={`backup-row-${backup.id}`}><TableCell className="whitespace-normal"><time dateTime={backup.createdAt}>{dateLabel(backup.createdAt)}</time></TableCell><TableCell className="whitespace-normal"><BackupStatus backup={backup} /></TableCell><TableCell>{backup.size ?? '—'}</TableCell><TableCell className="whitespace-normal">{dateLabel(backup.expiresAt)}</TableCell><TableCell className="text-right"><BackupActions backup={backup} initialRestoreKey={initialRestoreKey} returnTo={returnTo} onBackup={onBackup} onMutation={onMutation} /></TableCell></TableRow>;
}

function BackupMobileRow({ backup, initialRestoreKey, onBackup, onMutation, returnTo }: Readonly<{
  readonly backup: ResourceBackupView;
  readonly initialRestoreKey: string;
  readonly onBackup: (updater: (backups: readonly ResourceBackupView[]) => readonly ResourceBackupView[]) => void;
  readonly onMutation: (state: MutationState) => void;
  readonly returnTo: string;
}>) {
  return <article className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-4" data-testid={`backup-row-${backup.id}`}><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm"><div className="min-w-0"><dt className="text-muted-foreground">생성 시각</dt><dd className="break-words"><time dateTime={backup.createdAt}>{dateLabel(backup.createdAt)}</time></dd></div><div className="min-w-0"><dt className="text-muted-foreground">상태</dt><dd className="mt-1"><BackupStatus backup={backup} /></dd></div><div className="min-w-0"><dt className="text-muted-foreground">크기</dt><dd className="break-words">{backup.size ?? '—'}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">만료</dt><dd className="break-words">{dateLabel(backup.expiresAt)}</dd></div></dl><BackupActions backup={backup} initialRestoreKey={initialRestoreKey} returnTo={returnTo} onBackup={onBackup} onMutation={onMutation} /></article>;
}

function BackupStatus({ backup }: Readonly<{ readonly backup: ResourceBackupView }>) {
  const progress = statusProgress(backup.status);
  return <div className="flex min-w-32 flex-col gap-2"><Badge variant={statusVariant(backup.status)}>{backup.status}</Badge>{!terminalStatuses.has(backup.status) ? <Progress value={progress}><ProgressLabel>진행 상태</ProgressLabel><ProgressValue /></Progress> : null}{backup.status === 'FAILED' && backup.errorCode ? <span className="break-all font-mono text-xs text-muted-foreground">{backup.errorCode}</span> : null}</div>;
}

function BackupActions({ backup, initialRestoreKey, onBackup, onMutation, returnTo }: Readonly<{
  readonly backup: ResourceBackupView;
  readonly initialRestoreKey: string;
  readonly onBackup: (updater: (backups: readonly ResourceBackupView[]) => readonly ResourceBackupView[]) => void;
  readonly onMutation: (state: MutationState) => void;
  readonly returnTo: string;
}>) {
  const [restoreIntent, setRestoreIntent] = useState<RecoveryIntent>({ key: initialRestoreKey, payload: '' });
  const canRestore = isRecoverableAt(backup.status, backup.recoverable, backup.expiresAt, Date.now());
  const canDelete = ['READY', 'FAILED', 'EXPIRED', 'DELETING', 'DELETED'].includes(backup.status);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pending, setPending] = useState<'restore' | 'delete' | null>(null);
  async function submitRestore(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const name = form.get('name');
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(name)) return;
    const intent = resolveRecoveryIntent(restoreIntent, name, 'restore', createBrowserIdempotencyKey);
    if (intent !== restoreIntent) setRestoreIntent(intent);
    setPending('restore');
    onMutation({ kind: 'pending', target: backup.id });
    try {
      const response = await fetch(`/api/control/backups/${encodeURIComponent(backup.id)}/restores`, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ requestIdempotencyKey: intent.key, formatVersion: 1, name }) });
      const payload = await jsonPayload(response);
      const parsed = response.ok ? ResourceRestoreViewSchema.safeParse(payload) : null;
      if (!parsed || !parsed.success) { onMutation({ kind: 'error', code: safeRequestCode(payload) }); return; }
      onMutation({ kind: 'success', message: restoreMessage(parsed.data) });
      setRestoreIntent({ key: createBrowserIdempotencyKey('restore'), payload: '' });
      setRestoreDialogOpen(false);
    } catch (error) {
      if (error instanceof Error) {
        onMutation({ kind: 'error', code: 'recovery_request_unavailable' });
        return;
      }
      onMutation({ kind: 'error', code: 'recovery_request_unavailable' });
    } finally { setPending(null); }
  }

  async function submitDelete(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending('delete');
    onMutation({ kind: 'pending', target: backup.id });
    try {
      const response = await fetch(`/api/control/backups/${encodeURIComponent(backup.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
      const payload = await jsonPayload(response);
      const parsed = response.ok ? ResourceBackupViewSchema.safeParse(payload) : null;
      if (!parsed || !parsed.success) { onMutation({ kind: 'error', code: safeRequestCode(payload) }); return; }
      onBackup((backups) => upsertBackup(backups, parsed.data));
      onMutation({ kind: 'success', message: '백업 삭제 요청을 접수했습니다. 정리 상태를 이 화면에서 확인할 수 있습니다.' });
      setDeleteDialogOpen(false);
    } catch (error) {
      if (error instanceof Error) {
        onMutation({ kind: 'error', code: 'recovery_request_unavailable' });
        return;
      }
      onMutation({ kind: 'error', code: 'recovery_request_unavailable' });
    } finally { setPending(null); }
  }

  return <div className="flex flex-wrap justify-end gap-2"><Dialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}><DialogTrigger render={<Button size="sm" variant="outline" disabled={!canRestore} />}>복구 준비</DialogTrigger><DialogContent><DialogHeader><DialogTitle>새 리소스로 복구</DialogTitle><DialogDescription>현재 리소스를 바꾸지 않고, 이 백업으로 새 관리형 리소스를 준비합니다.</DialogDescription></DialogHeader><form action={`/api/control/backups/${encodeURIComponent(backup.id)}/restores`} method="post" onSubmit={submitRestore}><input name="_returnTo" type="hidden" value={returnTo} /><input name="requestIdempotencyKey" type="hidden" value={restoreIntent.key} /><input name="formatVersion" type="hidden" value="1" /><FieldGroup><Field><FieldLabel htmlFor={`restore-name-${backup.id}`}>새 리소스 이름</FieldLabel><Input id={`restore-name-${backup.id}`} name="name" pattern="[a-z][a-z0-9-]{0,47}" required autoComplete="off" /><FieldDescription>소문자, 숫자, 하이픈만 사용할 수 있습니다.</FieldDescription></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>취소</DialogClose><Button disabled={pending !== null} type="submit">{pending === 'restore' ? '복구 요청 중' : '복구 요청'}</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog><Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}><DialogTrigger render={<Button size="sm" variant="destructive" disabled={!canDelete} />}>삭제 요청</DialogTrigger><DialogContent><DialogHeader><DialogTitle>백업 삭제 요청</DialogTitle><DialogDescription>이 복구 지점을 삭제하도록 요청합니다. 삭제가 시작되면 복구에 사용할 수 없습니다.</DialogDescription></DialogHeader><form action={`/api/control/backups/${encodeURIComponent(backup.id)}`} method="post" onSubmit={submitDelete}><input name="_returnTo" type="hidden" value={returnTo} /><input name="_method" type="hidden" value="DELETE" /><input name="confirmed" type="hidden" value="true" /><DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>취소</DialogClose><Button disabled={pending !== null} type="submit">{pending === 'delete' ? '삭제 요청 중' : '삭제 요청 확인'}</Button></DialogFooter></form></DialogContent></Dialog></div>;
}

function restoreMessage(restore: ResourceRestoreView): string {
  return `새 리소스 복구 요청을 접수했습니다. 대상 리소스: ${restore.targetResourceId} (${restore.status})`;
}
