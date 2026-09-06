'use client';

import { MenuIcon } from 'lucide-react';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { Icon, type IconName } from './icon';
import { UserAvatar } from './user-avatar';
import { OrganizationSwitcher, type OrganizationSwitcherMembership } from './organization-switcher';

type MobileNavItem = { readonly id: string; readonly label: string; readonly href: string; readonly icon: IconName };

type ConsoleMobileNavProps = {
  readonly active: string;
  readonly eyebrow: string;
  readonly logoutAction: string;
  readonly navItems: readonly MobileNavItem[];
  readonly orgLabel: string;
  readonly orgValue: string;
  readonly organizationMemberships: readonly OrganizationSwitcherMembership[];
  readonly organizationRouteValue: string;
  readonly projectLabel: string;
  readonly projectValue: string;
  readonly userAvatarUrl?: string;
  readonly userEmail: string;
  readonly userName?: string;
};

export function ConsoleMobileNav({ active, eyebrow, logoutAction, navItems, orgLabel, orgValue, organizationMemberships, organizationRouteValue, projectLabel, projectValue, userAvatarUrl, userEmail, userName }: ConsoleMobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-2 md:hidden">
        <SheetTrigger render={<Button variant="outline" size="icon" aria-label="콘솔 메뉴 열기" />}><MenuIcon data-icon="inline-start" /></SheetTrigger>
        <a className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground" href="/console"><Brand height={26} width={26} /><span className="truncate">RAIBIT SERVER</span></a>
      </div>
      <SheetContent className="w-[calc(100%-2rem)] overflow-hidden sm:max-w-sm" side="left">
        <SheetHeader className="border-b border-border"><SheetTitle>RAIBIT SERVER 콘솔</SheetTitle><SheetDescription>{orgValue} · {projectValue}</SheetDescription></SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <div className="flex flex-col gap-3 border-b border-border px-2 pb-4">
            <div className="min-w-0"><p className="text-xs text-muted-foreground">{orgLabel}</p><OrganizationSwitcher currentOrganizationId={organizationRouteValue} memberships={organizationMemberships} /></div>
            <div className="min-w-0"><p className="text-xs text-muted-foreground">{projectLabel}</p><p className="truncate text-sm text-foreground" title={projectValue}>{projectValue}</p></div>
          </div>
          <nav className="flex flex-col gap-1 py-3" aria-label="모바일 콘솔 메뉴">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{eyebrow}</p>
            {navItems.map((item) => {
              const current = active === item.id;
              return <a key={item.id} className={cn('flex min-h-11 items-center gap-2 rounded-sm border-l-2 px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25', current ? 'border-primary bg-primary-soft text-primary' : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground')} aria-current={current ? 'page' : undefined} href={item.href} onClick={() => setOpen(false)}><Icon name={item.icon} /><span className="truncate">{item.label}</span></a>;
            })}
          </nav>
        </div>
        <SheetFooter className="border-t border-border">
          <div className="flex min-w-0 items-center gap-2">
            <UserAvatar avatarUrl={userAvatarUrl} email={userEmail} name={userName} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground" title={userName || '로그인 사용자'}>{userName || '로그인 사용자'}</p>
              <p className="truncate text-xs text-muted-foreground" title={userEmail}>{userEmail}</p>
            </div>
          </div>
          <form method="post" action={logoutAction}><input type="hidden" name="_returnTo" value="/login" /><button className={cn(buttonVariants({ variant: 'ghost' }), 'w-full justify-start')} type="submit">로그아웃</button></form>
          <SheetClose render={<Button className="w-full" variant="outline" />}>메뉴 닫기</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
