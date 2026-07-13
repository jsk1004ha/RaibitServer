import type { ReactNode } from 'react';
import './globals.css';

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
