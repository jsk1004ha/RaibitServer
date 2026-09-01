'use client';

import { ErrorScreen } from '../components/error-screen';
import { errorPageModel, normalizePublicIdentifier } from '../lib/error-page-model';
import './globals.css';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko" data-theme="system">
      <head>
        <title>오류가 발생했습니다 · RAIBIT SERVER</title>
      </head>
      <body>
        <ErrorScreen
          model={errorPageModel(500)}
          identifier={normalizePublicIdentifier(error.digest)}
          assertive
          actions={<><button type="button" className="inline-flex min-h-11 items-center rounded-sm bg-primary px-raibit-md text-button-md text-primary-foreground" onClick={reset}>다시 시도하기</button><a className="inline-flex min-h-11 items-center rounded-sm border border-input px-raibit-md text-button-md" href="/support">지원 보기</a></>}
        />
      </body>
    </html>
  );
}
