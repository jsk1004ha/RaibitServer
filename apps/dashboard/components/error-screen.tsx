import type { ReactNode } from 'react';
import type { ErrorPageModel } from '../lib/error-page-model';

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
    <main className="error-page">
      <section
        className="error-screen"
        aria-labelledby="error-screen-title"
        role={isAlert ? 'alert' : undefined}
        aria-live={isAlert ? 'assertive' : undefined}
      >
        <div className="error-signal" aria-hidden="true">
          <div className="error-code">{model.code}</div>
        </div>
        <div className="error-copy">
          <p className="error-eyebrow">RAIBIT SERVER · {model.eyebrow}</p>
          <h1 id="error-screen-title">{model.title}</h1>
          <p className="error-description">{model.description}</p>
          {(path || identifier) && (
            <dl className="error-details">
              {path && <><dt>요청 경로</dt><dd><code>{path}</code></dd></>}
              {identifier && <><dt>오류 식별자</dt><dd><code>{identifier}</code></dd></>}
            </dl>
          )}
          {actions && <div className="error-actions">{actions}</div>}
        </div>
      </section>
    </main>
  );
}
