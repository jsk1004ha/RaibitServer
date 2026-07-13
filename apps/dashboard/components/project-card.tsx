import { StatusBadge } from './console-ui';
import { Icon } from './icon';

type ProjectCardProps = {
  project: {
    id?: string;
    name?: string;
    slug?: string;
    status?: string;
    services?: number;
    resources?: number;
  };
  href?: string;
};

export function ProjectCard({ project, href }: ProjectCardProps) {
  const body = (
    <article className="project-row-card">
      <Icon name="folder" />
      <div className="project-identity">
        <h2>{project.name || project.slug || project.id}</h2>
        <p className="muted">서비스 {project.services ?? 0}개 · 리소스 {project.resources ?? 0}개</p>
      </div>
      <StatusBadge status={project.status || 'active'} />
      {href ? <span className="subtle-link">콘솔 열기 →</span> : null}
    </article>
  );
  return href ? <a href={href}>{body}</a> : body;
}
