import { SectionNavigationScroll } from './section-navigation-scroll';

export type SectionNavigationItem = Readonly<{
  description?: string;
  href: string;
  id: string;
  label: string;
}>;

type SectionNavigationProps = Readonly<{
  current: string;
  items: readonly SectionNavigationItem[];
  label: string;
}>;

export function SectionNavigation({ current, items, label }: SectionNavigationProps) {
  return (
    <nav aria-label={label} className="border-b border-border">
      <SectionNavigationScroll current={current}>
        {items.map((item) => {
          const isCurrent = item.id === current;
          return (
            <a
              aria-current={isCurrent ? 'page' : undefined}
              className="inline-flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-raibit-md text-button-md text-muted-foreground transition-colors aria-[current=page]:border-primary aria-[current=page]:text-primary"
              data-current={isCurrent || undefined}
              href={item.href}
              key={item.id}
            >
              <span>{item.label}</span>
              {item.description ? <span className="sr-only">: {item.description}</span> : null}
            </a>
          );
        })}
      </SectionNavigationScroll>
    </nav>
  );
}
