import type { ReactNode } from 'react';
import './globals.css';

// Nonce-based CSP requires every document to be rendered with the nonce created
// for its request by proxy.ts; static HTML cannot safely share a nonce.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'RAIBIT SERVER — 인천과학고 라이빗 호스팅',
  description: '인천과학고등학교 정보 동아리 라이빗의 호스팅 서비스. 프로젝트를 배포하고 함께 운영하세요.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
