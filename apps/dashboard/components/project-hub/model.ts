import type { ProjectView } from './types';
import { projectViews } from './types';

export function queryText(value: string | readonly string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

export function projectView(value: string): ProjectView {
  return projectViews.find((candidate) => candidate === value) ?? 'overview';
}

export function exactPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function projectNavigation(base: string) {
  return [
    { id: 'overview', label: '현황', description: '프로젝트 상태', href: `${base}?view=overview` },
    { id: 'services', label: '서비스', description: '실행 단위', href: `${base}?view=services` },
    { id: 'deployments', label: '배포', description: '배포 기록', href: `${base}?view=deployments` },
    { id: 'agent', label: 'AI 배포', description: '위협 점검·자동 실행', href: `${base}?view=agent` },
    { id: 'resources', label: '리소스', description: '데이터 계층', href: `${base}?view=resources` },
    { id: 'environment', label: '환경 변수', description: '비밀키 관리', href: `${base}?view=environment` },
    { id: 'logs', label: '로그', description: '실행 기록', href: `${base}?view=logs` },
    { id: 'settings', label: '설정', description: '프로젝트 관리', href: `${base}?view=settings` },
  ] as const;
}
