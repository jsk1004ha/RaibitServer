import type { ReactNode } from 'react';
import type { ErrorPageModel } from '../lib/error-page-model';
import { ThemeMenu } from './theme-menu';

type ErrorScreenProps = {
  model: ErrorPageModel;
  path?: string | null;
  identifier?: string | null;
  actions?: ReactNode;
  assertive?: boolean;
  role?: 'alert';
};

export function ErrorScreen({ model, path, identifier, actions, assertive = false, role }: ErrorScreenProps) {
  const isAlert = assertive || role === 'alert';
  return (
    <main id="main-content" className="grid min-h-[100dvh] grid-rows-[auto_1fr] bg-background px-raibit-lg py-raibit-xxl text-foreground lg:px-raibit-huge">
      <div data-slot="theme-utility" className="mx-auto flex w-full max-w-6xl justify-end">
        <ThemeMenu />
      </div>
      <section
        aria-labelledby="error-screen-title"
        className="mx-auto grid w-full max-w-6xl content-center gap-raibit-xxl lg:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1fr)]"
        role={isAlert ? 'alert' : undefined}
        aria-live={isAlert ? 'assertive' : undefined}
      >
        <div aria-hidden="true" className="border-b border-border pb-raibit-xl lg:flex lg:items-center lg:justify-end lg:border-b-0 lg:border-r lg:pb-0 lg:pr-raibit-xxl">
          <div className="font-mono text-display-xxl font-medium leading-none tracking-tight text-primary sm:text-display-xl lg:text-display-xxl">
            {model.code}
          </div>
        </div>
        <div className="min-w-0 lg:py-raibit-xl">
          <p className="font-mono text-micro uppercase tracking-widest text-muted-foreground">RAIBIT SERVER · {model.eyebrow}</p>
          <h1 id="error-screen-title" className="break-keep [overflow-wrap:anywhere]">{model.title}</h1>
          <p className="mt-raibit-lg max-w-2xl text-body-lg text-muted-foreground break-keep [overflow-wrap:anywhere]">{model.description}</p>
          {(path || identifier) && (
            <dl className="mt-raibit-xl grid max-w-2xl grid-cols-[auto_minmax(0,1fr)] gap-x-raibit-lg gap-y-raibit-sm border-t border-border pt-raibit-lg text-caption">
              {path && <><dt>요청 경로</dt><dd><code>{path}</code></dd></>}
              {identifier && <><dt>오류 식별자</dt><dd><code>{identifier}</code></dd></>}
            </dl>
          )}
          {actions ? <div className="mt-raibit-xl flex flex-wrap gap-raibit-sm">{actions}</div> : null}
        </div>
      </section>
    </main>
  );
}
