'use client';

import { ChevronDownIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { roleLabel } from '@/lib/console-navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type OrganizationSwitcherMembership = Readonly<{
  organizationId: string;
  organizationName?: string | null;
  organizationSlug?: string | null;
  role?: string | null;
}>;

type OrganizationSwitcherProps = Readonly<{
  currentOrganizationId: string;
  memberships: readonly OrganizationSwitcherMembership[];
}>;

function organizationHref(organizationId: string): string {
  return `/org/${encodeURIComponent(organizationId)}/projects`;
}

export function OrganizationSwitcher({ currentOrganizationId, memberships }: OrganizationSwitcherProps) {
  const organizations = memberships.filter((membership, index, rows) => membership.organizationId
    && rows.findIndex((candidate) => candidate.organizationId === membership.organizationId) === index);
  const selected = organizations.find((membership) => membership.organizationId === currentOrganizationId);
  const current = selected?.organizationName?.trim() || selected?.organizationSlug?.trim() || '현재 작업 공간';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button className="h-auto w-full justify-between px-0 py-0 text-left font-medium" size="sm" type="button" variant="ghost" />}>
        <span className="truncate" title={current}>{current}</span><ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
        <DropdownMenuLabel>내 작업 공간</DropdownMenuLabel>
        <p className="px-1.5 py-2 text-xs text-muted-foreground break-keep">프로젝트와 팀원을 함께 관리하는 공간입니다.</p>
        {organizations.map((membership, index) => (
          <DropdownMenuItem closeOnClick key={membership.organizationId} render={<a href={organizationHref(membership.organizationId)} />}>
            <span className="min-w-0 flex-1 truncate">{membership.organizationName?.trim() || membership.organizationSlug?.trim() || `작업 공간 ${index + 1}`}</span>
            {membership.role ? <span className="text-xs text-muted-foreground">{roleLabel(membership.role)}</span> : null}
          </DropdownMenuItem>
        ))}
        {!organizations.length ? <p className="px-1.5 py-2 text-sm text-muted-foreground">아직 참여 중인 작업 공간이 없습니다.</p> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem closeOnClick render={<a href="/organizations/new" />}><PlusIcon />새 작업 공간 만들기</DropdownMenuItem>
        {currentOrganizationId ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem closeOnClick render={<a href={`/org/${encodeURIComponent(currentOrganizationId)}/members`} />}><UsersIcon />팀원 관리</DropdownMenuItem>
        </> : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
