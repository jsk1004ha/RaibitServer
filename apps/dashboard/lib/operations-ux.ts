export function deploymentReceiptHref(returnTo: string, deploymentId: string): string | null {
  const match = /^\/org\/([^/?#\\]+)\/projects\/([^/?#\\]+)(?:[/?#]|$)/.exec(returnTo);
  if (!match || !deploymentId || deploymentId === '.' || deploymentId === '..') return null;
  const base = `/org/${match[1]}/projects/${match[2]}`;
  if (new URL(base, 'https://console.invalid').pathname !== base) return null;
  return `${base}/deployments/${encodeURIComponent(deploymentId)}?view=overview`;
}

export function logEmptyState(total: number, visible: number): 'empty' | 'filtered' | null {
  return total === 0 ? 'empty' : visible === 0 ? 'filtered' : null;
}

const deploymentLabels: Readonly<Record<string, string>> = {
  pending: '대기 중', queued: '대기 중', building: '빌드 중', deploying: '배포 중',
  ready: '실행 준비 완료', running: '실행 중', failed: '실패', cancelled: '취소됨',
  canceled: '취소됨', production: '운영', preview: '미리보기', unknown: '확인 중',
  image_ready: '배포 준비 완료', build_failed: '빌드 실패', manual: '수동',
  preview_cleanup_requested: '미리보기 정리 중', rollback_requested: '이전 배포로 복구 중', cleaned_up: '정리 완료',
};

export function deploymentLabel(value: string | undefined): string {
  return deploymentLabels[(value || 'unknown').toLowerCase()] || '확인 중';
}

export function shouldRefreshDeployment(status: string | undefined, attempts: number): boolean {
  return attempts < 12 && ['pending', 'queued', 'building', 'image_ready', 'deploying', 'preview_cleanup_requested', 'rollback_requested'].includes((status || '').toLowerCase());
}
