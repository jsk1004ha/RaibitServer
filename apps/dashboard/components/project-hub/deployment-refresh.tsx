'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { shouldRefreshDeployment } from '@/lib/operations-ux';

export function DeploymentRefresh({ status }: Readonly<{ status?: string }>) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const [pending, startTransition] = useTransition();
  const automatic = shouldRefreshDeployment(status, attempts);

  useEffect(() => {
    if (!automatic || pending) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') { setAttempts((value) => value + 1); return; }
      setAttempts((value) => value + 1);
      startTransition(() => router.refresh());
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [automatic, attempts, pending, router]);

  return <div className="flex flex-wrap items-center justify-between gap-raibit-sm">
    <p aria-live="polite" className="text-sm text-muted-foreground">{pending ? '최신 상태를 확인하고 있습니다.' : automatic ? '진행 중에는 5초마다 갱신합니다. 최대 1분 동안 확인합니다.' : '자동 확인이 멈췄습니다. 새로고침으로 최신 상태를 확인하세요.'}</p>
    <Button disabled={pending} onClick={() => { setAttempts(0); startTransition(() => router.refresh()); }} size="sm" type="button" variant="outline">새로고침</Button>
  </div>;
}
