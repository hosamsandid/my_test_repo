# 16 — Login, session, navigation

**Scope:** login/logout, session expiry, pre-auth screen, sidebar navigation,
redirects of retired routes, unknown routes, `/getting-started`, `/about`,
header breadcrumb and tab title.

## Probes

- Login: wrong password, empty fields, rate limit message, very long input,
  Enter to submit, password manager autofill attributes.
- No requests to protected APIs before login (network tab on the login screen).
- Session cookie expiry / logout in another tab → next action shows login, no
  blank page.
- Every sidebar entry per persona: entries a persona cannot use are hidden or
  explained; direct URL to hidden pages.
- Unknown route, trailing slash, different case: "Page not found" + tab title.
- Retired routes redirect (`/agents`, `/blueprints`, `/environments`, `/teams`,
  `/briefings`, `/process`, `/my-credentials`).
- Getting started: links work, steps match the current UI.

## Cleanup

Nothing is created in this area.
