import { useEffect, useState } from './vendor/preact-htm.js';

export type Theme = 'light' | 'dark';

const storageKey = 'dealio-admin-theme';

function saved(): Theme | null {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * The panel's theme. boot.js sets it before the first paint; a choice made
 * here is remembered in this browser, otherwise the system setting is followed.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (): void => {
      if (saved() !== null) return;
      apply(system());
      setTheme(system());
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  const toggle = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    apply(next);
    setTheme(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // Not remembered; the toggle still applies to this tab.
    }
  };
  return [theme, toggle];
}
