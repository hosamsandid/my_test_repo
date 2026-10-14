// Layout of the file-name area in the workspace file viewer header (#2986).
// Shared by the right-rail viewer, the expanded modal and the chat `@<path>`
// preview (all render FileViewerHeader), so the three behave identically.
//
// The name area takes the space left over by the icon + buttons and clips its
// content (it never paints over the buttons). Inside it the directory part
// shrinks first, down to nothing; the file name does not shrink but is capped
// at the area's width, so it only gets an ellipsis once the directory part is
// gone. Everything stays on one line, so the header height never grows.

// Split a workspace-relative path into its directory part (with trailing
// slash, '' at the workspace root) and its file name.
export function splitHeaderPath(relPath) {
  const idx = relPath.lastIndexOf('/');
  return {
    dir: idx >= 0 ? relPath.slice(0, idx + 1) : '',
    file: idx >= 0 ? relPath.slice(idx + 1) : relPath,
  };
}

const ellipsis = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

export const headerNameStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'baseline',
  gap: 0,
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'var(--eb-font-mono)',
};

export const headerDirStyle = {
  ...ellipsis,
  color: 'var(--eb-text-muted)',
  flexShrink: 1,
};

export const headerFileStyle = {
  ...ellipsis,
  color: 'var(--eb-text-primary)',
  fontWeight: 'var(--eb-font-medium)',
  flexShrink: 0,
  maxWidth: '100%',
};

// Header siblings of the name area (file icon, truncation warning, buttons)
// keep their size whatever the name length.
export const headerFixedStyle = { flexShrink: 0 };
