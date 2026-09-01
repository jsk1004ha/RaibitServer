import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default function ErrorFixtureLayout({ children }: { readonly children: ReactNode }) {
  return children;
}
