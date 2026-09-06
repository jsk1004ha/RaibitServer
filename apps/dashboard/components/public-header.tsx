import type { ReactNode } from 'react';
import { Brand } from './brand';
import { ThemeMenu } from './theme-menu';
import { buttonVariants } from './ui/button';

export type PublicNavigationItem = Readonly<{
  href: string;
  label: string;
}>;

export const publicNavigationItems = [
  { href: '/status', label: '운영 현황' },
  { href: '/support', label: '지원' },
] as const satisfies readonly PublicNavigationItem[];

type PublicHeaderProps = Readonly<{
  actions?: ReactNode;
  currentPath?: string;
  items?: readonly PublicNavigationItem[];
}>;

export function PublicHeader({
  actions,
  currentPath,
  items = publicNavigationItems,
}: PublicHeaderProps) {
  const resolvedActions = actions === undefined
    ? <a className={buttonVariants({ size: 'sm' })} href="/console">콘솔</a>
    : actions;

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex min-h-16 w-full max-w-7xl flex-col gap-raibit-sm px-raibit-lg py-raibit-sm sm:flex-row sm:items-center sm:justify-between sm:gap-raibit-md sm:px-raibit-xl">
        <div className="flex w-full items-center justify-between sm:w-auto">
          <a className="inline-flex min-h-11 items-center gap-raibit-sm text-button-md font-medium tracking-wide text-foreground" href="/">
            <Brand height={32} mode="informative" priority width={32} />
            <span>RAIBIT SERVER</span>
          </a>
          <ThemeMenu />
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-raibit-md sm:w-auto sm:flex-nowrap sm:justify-end">
          <nav aria-label="공개 화면 탐색" className="flex flex-wrap items-center gap-raibit-xs">
            {items.map((item) => (
              <a
                aria-current={currentPath === item.href ? 'page' : undefined}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm px-raibit-sm text-button-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                href={item.href}
                key={item.href}
              >
                {item.label}
              </a>
            ))}
          </nav>
          {resolvedActions}
        </div>
      </div>
    </header>
  );
}
