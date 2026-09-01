export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_COOKIE_NAME: 'raibit-theme';
export const THEME_STORAGE_KEY: 'raibit-theme';
export const THEME_COOKIE_MAX_AGE: number;
export const THEME_PREFERENCES: readonly ThemePreference[];

export function normalizeThemePreference(value: unknown): ThemePreference;
export function nextThemePreference(value: unknown): ThemePreference;
export function themePreferenceFromCookieHeader(cookieHeader: string | null | undefined): ThemePreference | null;
export function serializeThemeCookie(value: unknown, options?: { secure?: boolean }): string;
