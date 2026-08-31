'use client';

import { useEffect, useRef, type ReactNode } from 'react';

type SectionNavigationScrollProps = Readonly<{
  children: ReactNode;
  current: string;
}>;

export function SectionNavigationScroll({ children, current }: SectionNavigationScrollProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    viewportRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);

  return <div className="flex overflow-x-auto" ref={viewportRef}>{children}</div>;
}
