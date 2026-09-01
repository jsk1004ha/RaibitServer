import type { ReactNode } from 'react';

type PageHeaderProps = Readonly<{
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}>;

export function PageHeader({ actions, description, eyebrow, title }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-raibit-lg border-b border-border pb-raibit-xl">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <p className="mb-raibit-xs font-mono text-micro uppercase tracking-widest text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="text-display-md font-medium tracking-tight text-foreground sm:text-display-lg">{title}</h1>
        {description ? <div className="mt-raibit-sm text-body-md text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-raibit-sm">{actions}</div> : null}
    </header>
  );
}
