'use client';

import { useEffect, useRef, type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SectionNavigationScrollProps = Readonly<{
  as?: 'div' | 'ol' | 'ul';
  children: ReactNode;
  className?: string;
  current: string;
  viewportClassName?: string;
}>;

export function SectionNavigationScroll({
  as = 'div',
  children,
  className,
  current,
  viewportClassName,
}: SectionNavigationScrollProps) {
  const Viewport: ElementType = as;
  const viewportRef = useRef<HTMLElement>(null);

  useEffect(() => {
    viewportRef.current
      ?.querySelector<HTMLElement>('[aria-current]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);

  return (
    <div className={cn('min-w-0', className)}>
      <Viewport
        className={cn('flex min-w-0 overflow-x-auto overscroll-x-contain', viewportClassName)}
        data-horizontal-scroll-viewport
        ref={(node: HTMLElement | null) => {
          viewportRef.current = node;
        }}
      >
        {children}
      </Viewport>
      <p className="mt-2 text-xs text-muted-foreground lg:hidden" data-horizontal-scroll-hint>
        좌우로 스크롤해 더 보기
      </p>
    </div>
  );
}
