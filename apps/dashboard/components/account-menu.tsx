'use client';

import { LogOutIcon, ShieldCheckIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UserAvatar } from './user-avatar';

type AccountMenuProps = Readonly<{
  email?: string | null;
  name?: string | null;
  organization: string;
  role: string;
  avatarUrl?: string | null;
  logoutAction: string;
}>;

export function AccountMenu({ avatarUrl, email, logoutAction, name, organization, role }: AccountMenuProps) {
  const label = name?.trim() || email?.trim() || '로그인 사용자';
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <div className="contents" ref={setPortalContainer}><DropdownMenu>
    <DropdownMenuTrigger render={<button aria-label="계정 메뉴 열기" className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25" ref={triggerRef} type="button" />}>
      <UserAvatar avatarUrl={avatarUrl} email={email} name={name} size="sm" />
      <span className="min-w-0"><span className="block truncate text-xs font-medium text-foreground">{label}</span><span className="block truncate text-xs text-muted-foreground">{email || '이메일 정보 없음'}</span></span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-72" finalFocus={(closeType) => closeType === 'keyboard' ? triggerRef.current : false} portalContainer={portalContainer}>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="space-y-1"><span className="block truncate text-sm text-foreground">{label}</span><span className="block truncate font-normal">{email || '이메일 정보 없음'}</span><span className="block font-normal">{organization} · {role}</span></DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<a href="/account/security" />}><ShieldCheckIcon />계정 보안</DropdownMenuItem>
        <DropdownMenuSeparator />
        <form action={logoutAction} method="post"><input name="_returnTo" type="hidden" value="/login" /><DropdownMenuItem nativeButton render={<button type="submit" />} variant="destructive"><LogOutIcon />로그아웃</DropdownMenuItem></form>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu></div>;
}
