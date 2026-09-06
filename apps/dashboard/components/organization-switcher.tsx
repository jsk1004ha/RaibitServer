'use client';

import { ChevronDownIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type OrganizationSwitcherMembership = Readonly<{
  organizationId: string;
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
  const current = organizations.find((membership) => membership.organizationId === currentOrganizationId)?.organizationId
    ?? currentOrganizationId
    ?? '현재 조직';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button className="h-auto w-full justify-between px-0 py-0 text-left font-medium" size="sm" type="button" variant="ghost" />}>
        <span className="truncate" title={current}>{current}</span><ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>내 조직</DropdownMenuLabel>
        {organizations.map((membership) => (
          <DropdownMenuItem closeOnClick key={membership.organizationId} render={<a href={organizationHref(membership.organizationId)} />}>
            <span className="min-w-0 flex-1 truncate">{membership.organizationId}</span>
            {membership.role ? <span className="text-xs text-muted-foreground">{membership.role}</span> : null}
          </DropdownMenuItem>
        ))}
        {!organizations.length ? <p className="px-1.5 py-2 text-sm text-muted-foreground">아직 참여 중인 조직이 없습니다.</p> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem closeOnClick render={<a href="/organizations/new" />}><PlusIcon />새 조직 만들기</DropdownMenuItem>
        {currentOrganizationId ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem closeOnClick render={<a href={`/org/${encodeURIComponent(currentOrganizationId)}/members`} />}><UsersIcon />조직 관리</DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
