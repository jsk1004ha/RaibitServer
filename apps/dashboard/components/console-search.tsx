'use client';

import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';

export type ConsoleSearchItem = {
  readonly label: string;
  readonly href: string;
  readonly group: string;
  readonly keywords?: string;
};

type ConsoleSearchProps = { readonly compact?: boolean; readonly items: readonly ConsoleSearchItem[] };

export function ConsoleSearch({ compact = false, items }: ConsoleSearchProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasOpenedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const groups = useMemo(() => {
    const grouped = new Map<string, ConsoleSearchItem[]>();
    for (const item of items) {
      const entries = grouped.get(item.group) ?? [];
      entries.push(item);
      grouped.set(item.group, entries);
    }
    return [...grouped.entries()];
  }, [items]);

  useEffect(() => {
    if (compact) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element
        && event.target.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        if (!open && document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
        setOpen((value) => !value);
      } else if (!open && event.key === '/' && !editing) {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [compact, open]);

  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      return;
    }
    if (hasOpenedRef.current) {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
  }, [open]);

  return (
    <>
      <Button ref={triggerRef} aria-haspopup="dialog" aria-label="메뉴 검색" className={compact ? undefined : 'w-72 justify-between'} onClick={(event) => { returnFocusRef.current = event.currentTarget; setOpen(true); }} size={compact ? 'icon' : 'default'} type="button" variant="outline">
        <SearchIcon data-icon="inline-start" />
        {compact ? <span className="sr-only">메뉴 검색</span> : <span>메뉴 검색</span>}
        {compact ? null : <kbd className="text-xs text-muted-foreground">Ctrl K</kbd>}
      </Button>
      <CommandDialog description="콘솔 메뉴와 현재 프로젝트 화면을 검색합니다." open={open} onOpenChange={setOpen} title="메뉴 검색">
        <Command loop>
          <CommandInput autoFocus placeholder="메뉴 또는 프로젝트 화면 검색" />
          <CommandList>
            <CommandEmpty>검색 결과가 없습니다.</CommandEmpty>
            {groups.map(([group, entries]) => (
              <CommandGroup heading={group} key={group}>
                {entries.map((item) => (
                  <CommandItem key={`${item.group}-${item.href}`} onSelect={() => { setOpen(false); window.location.assign(item.href); }} value={`${item.label} ${item.group} ${item.keywords ?? ''}`}>
                    <span className="truncate">{item.label}</span>
                    <CommandShortcut>Enter</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
