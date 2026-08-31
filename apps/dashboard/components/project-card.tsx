import { ArrowUpRightIcon, BoxIcon, DatabaseIcon, FolderIcon } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export type ProjectSummary = {
  id?: string;
  name?: string;
  slug?: string;
  status?: string;
  organizationId?: string;
  organizationSlug?: string;
  services?: number;
  resources?: number;
  serviceCount?: number;
  resourceCount?: number;
};

type ProjectCardProps = {
  project: ProjectSummary;
  href?: string;
};

const statusLabels: Record<string, string> = { active: '활성', ready: '준비됨', running: '실행 중', pending: '대기 중', failed: '실패' };

function ProjectStatus({ status = 'active' }: { status?: string }) {
  const normalized = status.toLowerCase();
  return <Badge variant={normalized.includes('fail') ? 'destructive' : 'outline'}>{statusLabels[normalized] || status}</Badge>;
}

export function ProjectCard({ project, href }: ProjectCardProps) {
  const title = project.name || project.slug || project.id || '이름 없는 프로젝트';
  const identifier = project.slug || project.id;
  const serviceCount = project.services ?? project.serviceCount ?? 0;
  const resourceCount = project.resources ?? project.resourceCount ?? 0;
  const body = (
    <Card size="sm" className="transition-[border-color,box-shadow] group-hover:border-foreground/20 group-hover:shadow-[0_2px_8px_rgb(0_0_0/0.07)] group-focus-visible:border-ring group-focus-visible:ring-3 group-focus-visible:ring-ring/25">
      <CardContent className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 sm:gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary" aria-hidden="true"><FolderIcon className="size-4" /></span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 break-words text-sm font-medium text-foreground">{title}</span><ProjectStatus status={project.status} /></span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {identifier ? <code className="max-w-full break-all font-mono">{identifier}</code> : null}
            <span className="inline-flex items-center gap-1"><BoxIcon className="size-3.5" /> 서비스 {serviceCount}개</span>
            <span className="inline-flex items-center gap-1"><DatabaseIcon className="size-3.5" /> 리소스 {resourceCount}개</span>
          </span>
        </span>
        {href ? <ArrowUpRightIcon className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" /> : null}
      </CardContent>
    </Card>
  );
  return href ? <Link className="group block rounded-lg outline-none" href={href} aria-label={`${title} 프로젝트 콘솔 열기`}>{body}</Link> : body;
}
