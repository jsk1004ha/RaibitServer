'use client';

import { useEffect, useState } from 'react';
import { Icon, type IconName } from '@/components/icon';
import {
  THEME_STORAGE_KEY,
  nextThemePreference,
  normalizeThemePreference,
  serializeThemeCookie,
  themePreferenceFromCookieHeader,
  type ThemePreference,
} from '@/lib/theme';

const themePresentation: Record<ThemePreference, { icon: IconName; label: string; nextLabel: string }> = {
  system: { icon: 'computer-desktop', label: '시스템', nextLabel: '라이트' },
  light: { icon: 'sun', label: '라이트', nextLabel: '다크' },
  dark: { icon: 'moon', label: '다크', nextLabel: '시스템' },
};

function readLocalPreference() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === null ? null : normalizeThemePreference(value);
  } catch {
    return null;
  }
}

function applyPreference(preference: ThemePreference) {
  document.documentElement.dataset.theme = preference;
}

function persistPreference(preference: ThemePreference) {
  document.cookie = serializeThemeCookie(preference, { secure: window.location.protocol === 'https:' });
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Cookie persistence remains available when storage is disabled.
  }
}

export function ThemeToggle({ initialTheme }: { initialTheme: ThemePreference }) {
  const [preference, setPreference] = useState(() => normalizeThemePreference(initialTheme));

  useEffect(() => {
    const restored = themePreferenceFromCookieHeader(document.cookie) ?? readLocalPreference();
    if (restored !== null) {
      applyPreference(restored);
      setPreference(restored);
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const nextPreference = normalizeThemePreference(event.newValue);
      applyPreference(nextPreference);
      setPreference(nextPreference);
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const presentation = themePresentation[preference];
  const accessibleLabel = `현재 ${presentation.label} 테마입니다. ${presentation.nextLabel} 테마로 변경`;

  return (
    <button
      type="button"
      data-theme-toggle
      data-preference={preference}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={() => {
        const nextPreference = nextThemePreference(preference);
        applyPreference(nextPreference);
        persistPreference(nextPreference);
        setPreference(nextPreference);
      }}
    >
      <Icon name={presentation.icon} />
      <span data-theme-toggle-label>{presentation.label}</span>
    </button>
  );
}
