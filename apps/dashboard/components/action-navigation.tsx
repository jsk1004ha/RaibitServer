export type ActionNavigationItem = Readonly<{
  description?: string;
  href: string;
  label: string;
}>;

type ActionNavigationProps = Readonly<{
  current?: string;
  items: readonly ActionNavigationItem[];
  label: string;
}>;

export function ActionNavigation({ current, items, label }: ActionNavigationProps) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-raibit-sm">
      {items.map((item) => {
        const isCurrent = item.href === current;
        return (
          <a
            aria-current={isCurrent ? 'page' : undefined}
            className="inline-flex min-h-11 items-center rounded-sm border border-input bg-background px-raibit-md text-button-md text-foreground transition-colors hover:bg-muted"
            href={item.href}
            key={item.href}
          >
            <span>{item.label}</span>
            {item.description ? <span className="sr-only">: {item.description}</span> : null}
          </a>
        );
      })}
    </nav>
  );
}
