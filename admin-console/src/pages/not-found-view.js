// Pure copy + link targets for the 404 page (#2615), kept React-free so it is
// unit-tested under `node --test` (the #651 convention); NotFound.jsx only
// renders it.

import { NOT_FOUND_LABEL } from '../components/breadcrumbs.js';

// Agent Chat is the console's landing page (`/` redirects there), so it is the
// one safe place to send someone whose link went nowhere.
export const HOME_ROUTE = '/chats';

export const NOT_FOUND_COPY = {
  title: NOT_FOUND_LABEL,
  body: 'There is no page at this address. The link may be mistyped, outdated, or point to a page that has been removed.',
  home: 'Go to Agent Chat',
  help: 'Open Help',
  hint: 'You can also pick a page from the sidebar.',
};

// The requested path as shown on the page: pathname plus query, never the hash
// (a fragment is client-only noise here), capped so a pasted monster URL cannot
// blow up the layout.
export function requestedPathLabel(pathname, search = '', max = 200) {
  const p = `${pathname || '/'}${search || ''}`;
  return p.length > max ? `${p.slice(0, max)}…` : p;
}
