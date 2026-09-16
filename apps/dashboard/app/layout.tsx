import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { e2eFixturesEnabled } from '@/lib/e2e-fixture-policy';
import { THEME_COOKIE_NAME, normalizeThemePreference } from '@/lib/theme';
import './globals.css';
import './fonts.css';

// Nonce-based CSP requires every document to be rendered with the nonce created
// for its request by proxy.ts; static HTML cannot safely share a nonce.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'RAIBIT SERVER — 인천과학고 라이빗 호스팅',
  description: '인천과학고등학교 정보 동아리 라이빗의 호스팅 서비스. 프로젝트를 배포하고 함께 운영하세요.',
};

class T6GlobalErrorFixture extends Error {
  constructor() {
    super('T6_E2E_GLOBAL_ERROR');
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [requestCookies, requestHeaders] = await Promise.all([cookies(), headers()]);
  if (e2eFixturesEnabled(process.env, requestHeaders.get('host')) && requestCookies.get('T6_E2E_GLOBAL_ERROR')?.value === '1') {
    throw new T6GlobalErrorFixture();
  }
  const theme = normalizeThemePreference(requestCookies.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="ko" data-theme={theme}>
      <body className="bg-background font-sans text-foreground">
        <nav aria-label="바로가기">
          <a
            className="fixed left-raibit-md top-raibit-md z-50 -translate-y-[calc(100%+var(--space-md))] rounded-sm bg-primary px-raibit-md py-raibit-sm text-button-md text-primary-foreground focus:translate-y-0"
            href="#main-content"
          >
            본문으로 건너뛰기
          </a>
        </nav>
        {children}
      </body>
    </html>
  );
}
