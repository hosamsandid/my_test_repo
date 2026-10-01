// copy-text.js — copy a string to the clipboard, with a fallback for
// non-secure contexts (#2654). On plain http `navigator.clipboard` is
// undefined, so a bare `navigator.clipboard.writeText` inside an empty catch
// made "Copy" silently do nothing. The fallback selects the text in an
// off-screen textarea and runs `document.execCommand('copy')`, which browsers
// still honour from a click handler.
//
// Resolves to true when the text was copied, false otherwise, so the caller
// can tell the user to copy it by hand. `env` is injectable for node:test
// (the #651 convention); it defaults to the browser globals.

export async function copyText(text, env = defaultEnv()) {
  const value = String(text ?? '');
  const clipboard = env.navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return true;
    } catch { /* denied or unavailable — try the legacy path below */ }
  }
  return legacyCopy(value, env.document);
}

function legacyCopy(value, doc) {
  if (!doc || typeof doc.execCommand !== 'function' || !doc.body) return false;
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

function defaultEnv() {
  return {
    navigator: typeof navigator !== 'undefined' ? navigator : undefined,
    document: typeof document !== 'undefined' ? document : undefined,
  };
}

// Shown when neither path worked, next to the (selected) text.
export const COPY_FAILED_HINT = 'Could not copy automatically — the text is selected; press Ctrl+C (⌘C) to copy it.';
