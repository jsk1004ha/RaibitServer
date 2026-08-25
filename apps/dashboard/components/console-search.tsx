'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from './icon';

export type ConsoleSearchItem = {
  label: string;
  href: string;
  group: string;
  keywords?: string;
};

export function ConsoleSearch({ items }: { items: ConsoleSearchItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasOpenedRef = useRef(false);

  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('ko');
    if (!term) return items;
    return items.filter((item) => `${item.label} ${item.group} ${item.keywords || ''}`.toLocaleLowerCase('ko').includes(term));
  }, [items, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (!open && event.key === '/' && !editing) {
        event.preventDefault();
        setOpen(true);
      } else if (open && event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      setQuery('');
      setActiveIndex(0);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (hasOpenedRef.current) triggerRef.current?.focus();
  }, [open]);

  const close = () => setOpen(false);
  const handleListKeys = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault();
      window.location.assign(results[activeIndex].href);
    }
  };

  return (
    <>
      <button ref={triggerRef} className="console-search-trigger" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="메뉴 검색">
        <Icon name="magnifying-glass" />
        <span>메뉴 검색</span>
        <kbd>Ctrl K</kbd>
      </button>
      {open ? (
        <div className="command-palette-backdrop" role="presentation" onMouseDown={close}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="메뉴 검색" onMouseDown={(event) => event.stopPropagation()}>
            <div className="command-palette-input">
              <Icon name="magnifying-glass" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                onKeyDown={handleListKeys}
                placeholder="메뉴 검색"
                aria-label="메뉴 검색어"
                aria-controls="console-search-results"
              />
              <kbd>ESC</kbd>
            </div>
            <div id="console-search-results" className="command-palette-results" role="listbox">
              {results.length ? results.map((item, index) => (
                <a
                  key={`${item.group}-${item.href}`}
                  href={item.href}
                  className={index === activeIndex ? 'active' : ''}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span><strong>{item.label}</strong><small>{item.group}</small></span>
                  <span aria-hidden="true">→</span>
                </a>
              )) : <p className="command-palette-empty">검색 결과 없음</p>}
            </div>
            <footer><span>↑↓ 이동</span><span>Enter 열기</span><span>Esc 닫기</span></footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
