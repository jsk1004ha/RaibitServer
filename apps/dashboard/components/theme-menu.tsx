'use client';

import { useEffect, useRef, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  serializeThemeCookie,
  themePreferenceFromCookieHeader,
  type ThemePreference,
} from '@/lib/theme';

const THEME_CHANGE_EVENT = 'raibit-theme-change';

const themePresentation: Record<ThemePreference, { icon: LucideIcon; label: string }> = {
  system: { icon: MonitorIcon, label: '시스템' },
  light: { icon: SunIcon, label: '라이트' },
  dark: { icon: MoonIcon, label: '다크' },
};

function readLocalPreference(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === null ? null : normalizeThemePreference(value);
  } catch {
    return null;
  }
}

function applyPreference(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference;
}

function persistCookie(preference: ThemePreference): void {
  document.cookie = serializeThemeCookie(preference, { secure: window.location.protocol === 'https:' });
}

function persistPreference(preference: ThemePreference): void {
  persistCookie(preference);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Host-only cookie persistence remains available when storage is disabled.
  }
}

function preferenceFromThemeEvent(event: Event): ThemePreference {
  return event instanceof CustomEvent ? normalizeThemePreference(event.detail) : 'system';
}

export function ThemeMenu({ initialTheme = 'system' }: { initialTheme?: ThemePreference }) {
  const [preference, setPreference] = useState(() => normalizeThemePreference(initialTheme));
  const selectingPreference = useRef(false);
  const presentation = themePresentation[preference];
  const accessibleLabel = `테마 설정: 현재 ${presentation.label}`;

  useEffect(() => {
    const reconcile = () => {
      const restored = themePreferenceFromCookieHeader(document.cookie)
        ?? readLocalPreference()
        ?? normalizeThemePreference(document.documentElement.dataset.theme);
      applyPreference(restored);
      setPreference(restored);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const nextPreference = normalizeThemePreference(event.newValue);
      applyPreference(nextPreference);
      persistCookie(nextPreference);
      setPreference(nextPreference);
    };
    const handleThemeChange = (event: Event) => {
      if (selectingPreference.current) return;
      const nextPreference = preferenceFromThemeEvent(event);
      applyPreference(nextPreference);
      setPreference(nextPreference);
    };

    reconcile();
    window.addEventListener('storage', handleStorage);
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    };
  }, []);

  const selectPreference = (value: string) => {
    const nextPreference = normalizeThemePreference(value);
    selectingPreference.current = true;
    applyPreference(nextPreference);
    persistPreference(nextPreference);
    setPreference(nextPreference);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: nextPreference }));
    selectingPreference.current = false;
  };

  const ThemeIcon = presentation.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label={accessibleLabel} title={accessibleLabel} />}>
        <ThemeIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup aria-label="테마 선택" value={preference} onValueChange={selectPreference}>
          <DropdownMenuLabel>테마</DropdownMenuLabel>
          <DropdownMenuRadioItem value="system" closeOnClick>시스템</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light" closeOnClick>라이트</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" closeOnClick>다크</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
