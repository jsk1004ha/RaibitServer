import { Brand } from './brand';

const githubUrl = 'https://github.com/jsk1004ha/RaibitServer';

export function PublicFooter() {
  return (
    <footer className="mt-raibit-huge border-t border-border py-raibit-xxl text-caption text-muted-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-raibit-lg px-raibit-lg sm:px-raibit-xl lg:flex-row lg:items-center lg:justify-between">
        <a className="inline-flex min-h-11 items-center gap-raibit-sm text-button-md text-foreground" href="/">
          <Brand height={28} width={28} />
          <span>RAIBIT SERVER</span>
        </a>
        <nav className="flex flex-wrap items-center gap-x-raibit-lg gap-y-raibit-xs" aria-label="푸터 탐색">
          <a className="inline-flex min-h-11 items-center hover:text-foreground" href="/support">Support</a>
          <a className="inline-flex min-h-11 items-center hover:text-foreground" href="/status">System Status</a>
          <a className="inline-flex min-h-11 items-center hover:text-foreground" href={githubUrl} target="_blank" rel="noreferrer">GitHub</a>
          <a className="inline-flex min-h-11 items-center hover:text-foreground" href="/contributors">Contributors</a>
          <a className="inline-flex min-h-11 items-center hover:text-foreground" href="/privacy">Privacy Policy</a>
        </nav>
        <span>© 2026 Raibit, ISHS.</span>
      </div>
    </footer>
  );
}
