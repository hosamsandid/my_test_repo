import { useState, useCallback } from 'react';

const STORAGE_KEY = 'eb-theme';
const VALID_THEMES = ['admin-dark', 'admin-light', 'high-contrast'];

function readCurrentTheme() {
  return document.documentElement.dataset.theme || 'admin-dark';
}

export default function useTheme() {
  const [theme, setThemeState] = useState(readCurrentTheme);

  const setTheme = useCallback((next) => {
    if (!VALID_THEMES.includes(next)) return;
    document.documentElement.dataset.theme = next;
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const toggleLightDark = useCallback(() => {
    setTheme(theme === 'admin-light' ? 'admin-dark' : 'admin-light');
  }, [theme, setTheme]);

  return { theme, setTheme, toggleLightDark };
}
