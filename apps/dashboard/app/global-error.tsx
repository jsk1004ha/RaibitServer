'use client';

import { ErrorScreen } from '../components/error-screen';
import { errorPageModel, normalizePublicIdentifier } from '../lib/error-page-model';
import './globals.css';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko" data-theme="light">
      <body>
        <ErrorScreen
          model={errorPageModel(500)}
          identifier={normalizePublicIdentifier(error.digest)}
          assertive
          actions={<button type="button" className="btn btn-primary" onClick={reset}>다시 시도하기</button>}
        />
      </body>
    </html>
  );
}
