import type { ReactNode } from 'react';
import './globals.css';

// Nonce-based CSP requires every document to be rendered with the nonce created
// for its request by proxy.ts; static HTML cannot safely share a nonce.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'RAIBITSERVER',
  description: '클럽, 학교, 소규모 팀을 위한 컨테이너 기반 PaaS 및 DBaaS.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
