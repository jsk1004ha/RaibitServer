'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

const conflictCodes = [
  'GITHUB_DUPLICATE_IMPORT',
  'GITHUB_PROJECT_SLUG_COLLISION',
  'GITHUB_SERVICE_ALREADY_BOUND',
  'GITHUB_INSTALLATION_MISMATCH',
  'GITHUB_DEFAULT_BRANCH_MISSING',
  'GITHUB_DEFAULT_BRANCH_CHANGED',
  'GITHUB_SOURCE_ACCESS_REVOKED',
  'GITHUB_CATALOG_STALE',
  'GITHUB_SOURCE_DISCONNECTED',
  'GITHUB_IDEMPOTENCY_CONFLICT',
] as const;

const recoveryActions = [
  'OPEN_EXISTING_PROJECT',
  'OPEN_EXISTING_SERVICE',
  'CHOOSE_NEW_SLUG',
  'REFRESH_CATALOG',
  'REATTACH_INSTALLATION',
  'SELECT_BRANCH',
  'CANCEL',
] as const;

type GitHubConflictCode = typeof conflictCodes[number];
type GitHubRecoveryAction = typeof recoveryActions[number];

type GitHubConflict = {
  readonly code: GitHubConflictCode;
  readonly recovery: {
    readonly action: GitHubRecoveryAction;
    readonly projectId?: string;
    readonly serviceId?: string;
    readonly installationId?: string;
    readonly repositoryId?: string;
    readonly currentDefaultBranch?: string;
    readonly requestedBranch?: string;
    readonly suggestedSlug?: string;
  };
};

type Props = {
  readonly conflict: GitHubConflict;
  readonly projectHrefs: Readonly<Record<string, string>>;
  readonly onCancel: () => void;
  readonly onFocusBranch: () => void;
  readonly onFocusSlug: () => void;
};

export function GitHubConflictRecovery({ conflict, onCancel, onFocusBranch, onFocusSlug, projectHrefs }: Props) {
  const recovery = conflict.recovery;
  const projectHref = recovery.projectId ? projectHrefs[recovery.projectId] : undefined;
  return (
    <Alert data-github-recovery variant="destructive">
      <AlertTitle>{conflictTitle(conflict.code)}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{conflictDescription(conflict.code)}</span>
        {recovery.currentDefaultBranch || recovery.requestedBranch ? <span>현재 기본 브랜치: {recovery.currentDefaultBranch || '확인 필요'} · 요청 브랜치: {recovery.requestedBranch || '확인 필요'}</span> : null}
        {recovery.suggestedSlug ? <span>사용 가능한 이름 제안: {recovery.suggestedSlug}</span> : null}
        <RecoveryAction onCancel={onCancel} onFocusBranch={onFocusBranch} onFocusSlug={onFocusSlug} projectHref={projectHref} recovery={recovery} />
      </AlertDescription>
    </Alert>
  );
}

function RecoveryAction({ onCancel, onFocusBranch, onFocusSlug, projectHref, recovery }: Readonly<{
  onCancel: () => void;
  onFocusBranch: () => void;
  onFocusSlug: () => void;
  projectHref: string | undefined;
  recovery: GitHubConflict['recovery'];
}>) {
  if (recovery.action === 'OPEN_EXISTING_PROJECT') return projectHref ? <a data-github-recovery-action="open-project" href={projectHref}>기존 프로젝트 열기</a> : <CancelButton onCancel={onCancel} />;
  if (recovery.action === 'OPEN_EXISTING_SERVICE') return projectHref && recovery.serviceId ? <a data-github-recovery-action="open-service" href={`${projectHref}?view=services&serviceId=${encodeURIComponent(recovery.serviceId)}`}>기존 서비스 열기</a> : <CancelButton onCancel={onCancel} />;
  if (recovery.action === 'CHOOSE_NEW_SLUG') return <Button data-github-recovery-action="choose-new-slug" onClick={onFocusSlug} type="button" variant="outline">새 서비스 슬러그 선택</Button>;
  if (recovery.action === 'REFRESH_CATALOG') return recovery.installationId ? <a data-github-recovery-action="refresh-catalog" href={`/github?installation=${encodeURIComponent(recovery.installationId)}`}>저장소 카탈로그 새로고침</a> : <CancelButton onCancel={onCancel} />;
  if (recovery.action === 'REATTACH_INSTALLATION') return <a data-github-recovery-action="reattach-installation" href="/github/install">신뢰된 설치 흐름으로 다시 연결</a>;
  if (recovery.action === 'SELECT_BRANCH') return <Button data-github-recovery-action="select-branch" onClick={onFocusBranch} type="button" variant="outline">브랜치 직접 선택</Button>;
  return <CancelButton onCancel={onCancel} />;
}

function CancelButton({ onCancel }: Readonly<{ onCancel: () => void }>) {
  return <Button data-github-recovery-action="cancel" onClick={onCancel} type="button" variant="outline">취소</Button>;
}

function conflictTitle(code: GitHubConflictCode): string {
  if (code === 'GITHUB_DUPLICATE_IMPORT') return '이미 가져온 저장소입니다.';
  if (code === 'GITHUB_PROJECT_SLUG_COLLISION') return '서비스 슬러그가 이미 사용 중입니다.';
  if (code === 'GITHUB_SERVICE_ALREADY_BOUND') return '서비스가 다른 GitHub 소스에 연결되어 있습니다.';
  if (code === 'GITHUB_INSTALLATION_MISMATCH') return '선택한 GitHub 설치가 일치하지 않습니다.';
  if (code === 'GITHUB_DEFAULT_BRANCH_MISSING') return '기본 브랜치를 찾을 수 없습니다.';
  if (code === 'GITHUB_DEFAULT_BRANCH_CHANGED') return 'GitHub 기본 브랜치가 변경되었습니다.';
  if (code === 'GITHUB_SOURCE_ACCESS_REVOKED') return 'GitHub 저장소 접근이 철회되었습니다.';
  if (code === 'GITHUB_CATALOG_STALE') return '저장소 카탈로그가 오래되었습니다.';
  if (code === 'GITHUB_SOURCE_DISCONNECTED') return 'RAIBITSERVER GitHub 연결이 해제되었습니다.';
  return '이 요청 키는 다른 요청에 이미 사용되었습니다.';
}

function conflictDescription(code: GitHubConflictCode): string {
  if (code === 'GITHUB_DEFAULT_BRANCH_CHANGED') return '현재 GitHub 상태를 확인한 뒤 사용할 브랜치를 명시적으로 선택하세요.';
  if (code === 'GITHUB_SOURCE_ACCESS_REVOKED' || code === 'GITHUB_SOURCE_DISCONNECTED') return '기존 연결을 덮어쓰지 않았습니다. 연결 상태를 확인한 뒤 다시 시도하세요.';
  if (code === 'GITHUB_CATALOG_STALE') return '표시 중인 저장소 목록으로는 변경하지 않았습니다. 최신 목록을 확인하세요.';
  return '현재 변경은 적용하지 않았습니다. 아래 복구 작업을 선택하거나 취소하세요.';
}

export function githubConflictFromPayload(value: unknown): GitHubConflict | null {
  if (!isRecord(value) || value.statusCode !== 409 || !isGitHubConflictCode(value.code) || value.message !== value.code || value.error !== value.code || value.retryable !== false || value.terminal !== true || value.permission !== false || !isRecord(value.recovery)) return null;
  const recovery = value.recovery;
  const action = recovery.action;
  if (!isRecoveryAction(action)) return null;
  return {
    code: value.code,
    recovery: {
      action,
      ...(safeId(recovery.projectId) ? { projectId: recovery.projectId } : {}),
      ...(safeId(recovery.serviceId) ? { serviceId: recovery.serviceId } : {}),
      ...(safeId(recovery.installationId) ? { installationId: recovery.installationId } : {}),
      ...(safeId(recovery.repositoryId) ? { repositoryId: recovery.repositoryId } : {}),
      ...(safeBranch(recovery.currentDefaultBranch) ? { currentDefaultBranch: recovery.currentDefaultBranch } : {}),
      ...(safeBranch(recovery.requestedBranch) ? { requestedBranch: recovery.requestedBranch } : {}),
      ...(safeSlug(recovery.suggestedSlug) ? { suggestedSlug: recovery.suggestedSlug } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGitHubConflictCode(value: unknown): value is GitHubConflictCode {
  return typeof value === 'string' && conflictCodes.some((code) => code === value);
}

function isRecoveryAction(value: unknown): value is GitHubRecoveryAction {
  return typeof value === 'string' && recoveryActions.some((action) => action === value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}

function safeSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})?$/.test(value);
}

function safeBranch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,255}$/.test(value);
}
