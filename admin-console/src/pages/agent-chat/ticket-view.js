/**
 * Pure display + input helpers for the parent-ticket toolbar (#1383). No React.
 *
 * A "ticket" binds an Agent Chat room to a parent GitHub issue. The ChatPanel
 * toolbar shows the bound issue (or "No parent ticket"), and two actions bind
 * one: "+ New issue" (create) and "Attach existing" (by number or URL). All the
 * branchy formatting + client-side input pre-validation lives here so it lands
 * in the `admin-console-src` `node --test` job (#651); the JSX in ChatPanel /
 * SessionsPanel stays uncovered per the same convention (mirrors
 * `message-draft.js` / `message-send-keybinding.js`).
 */

// Shown in the toolbar when no ticket is bound for the current agent+room.
export const NO_TICKET_LABEL = 'No parent ticket';

// A GitHub issue URL (host ignored — only owner/repo/number matter). Kept in
// sync with the server-side `orchestrator/ticket-store.js` ISSUE_URL_RE.
const ISSUE_URL_RE = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[?#].*)?$/;

/**
 * Client-side pre-validation of the "Attach existing" input. Mirrors the
 * authoritative server parse in `ticket-store.js` so the dialog can disable its
 * submit button and show a hint before the round-trip. Accepts a bare positive
 * integer ("123" / "#123") or a GitHub issue URL.
 * @returns {{kind:'number',number:number}|{kind:'url',owner:string,repo:string,number:number}|null}
 */
export function parseIssueRefInput(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(ISSUE_URL_RE);
  if (m) {
    const number = Number(m[3]);
    if (!Number.isInteger(number) || number < 1) return null;
    return { kind: 'url', owner: m[1], repo: m[2], number };
  }
  const bare = s.replace(/^#/, '');
  if (/^\d+$/.test(bare)) {
    const number = Number(bare);
    if (Number.isInteger(number) && number >= 1) return { kind: 'number', number };
  }
  return null;
}

/** Truncate a title for the compact toolbar chip, adding an ellipsis. */
export function truncateTitle(title, max = 40) {
  const t = typeof title === 'string' ? title : '';
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/**
 * A description of the bound ticket for rendering, or null when unbound.
 * @returns {{number:number,repo:string,title:string,label:string,href:string,state:string|null,closed:boolean}|null}
 */
export function describeTicket(ticket, { titleMax = 40 } = {}) {
  if (!ticket || typeof ticket !== 'object') return null;
  const number = Number(ticket.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const repo = typeof ticket.repo === 'string' ? ticket.repo : '';
  const title = typeof ticket.title === 'string' ? ticket.title : '';
  const state = typeof ticket.state === 'string' && ticket.state ? ticket.state : null;
  const truncated = truncateTitle(title, titleMax);
  const label = truncated ? `#${number} ${truncated}` : `#${number}`;
  return {
    number,
    repo,
    title,
    label,
    href: ticketHref(ticket),
    state,
    closed: state === 'closed',
  };
}

/** The GitHub link for a ticket — its stored url, else derived from repo+number. */
export function ticketHref(ticket) {
  if (!ticket || typeof ticket !== 'object') return '';
  if (typeof ticket.url === 'string' && ticket.url) return ticket.url;
  const number = Number(ticket.number);
  if (typeof ticket.repo === 'string' && ticket.repo && Number.isInteger(number) && number >= 1) {
    return `https://github.com/${ticket.repo}/issues/${number}`;
  }
  return '';
}
