// ─── Credentials help chapters (#1993, epic #1981) ───────────────────────────
//
// `help-topics/credentials.md` is the first MULTI-ROUTE topic (E10 #1884): one
// file claimed by /ssh-keys and /github-tokens. That is exactly
// why it needs chapters — a reader arriving from the GitHub Tokens page landed
// at the top of an explanation whose first third is about SSH. Each page's "?"
// now opens the shared topic AT the chapter written for that page.
//
// A chapter is addressed by the slug of its heading (see sectionSlug in
// context/page-help-view.js), so this file is the one place the slugs are
// written down — every call site imports from here, and
// credentials-help-extraction.test.js asserts each value is really a heading in
// the topic.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also why the cross-page chapters (whyBoth,
// personalCredentials, tiers, rotation) carry no "?" of their own — they are the shared story every page
// needs, and the panel renders the WHOLE topic, so they are one scroll away from
// wherever a deep link lands rather than hidden behind an affordance.
//
// It lives flat beside the pages' other pure modules (credential-scope-view.js,
// credential-usage.js, github-token-view.js) rather than
// in a pages/credentials/ directory of its own — same call as #1990 made for
// Skills; a one-file directory would be the odd one out here.

export const CREDENTIALS_HELP_SECTIONS = {
  // 1 — the defense-in-depth story, authored once for both pages
  whyBoth: 'why-both-an-ssh-key-and-a-github-token',
  // 2 — /ssh-keys: transport, deploy keys, fingerprint-only readback
  sshKeys: 'ssh-keys',
  // 3 — /github-tokens: the Events API, gh, HTTPS git, GH_TOKEN injection
  githubTokens: 'github-tokens',
  // 4 — the self-service personal tier (on both pages since #2360/#2445)
  personalCredentials: 'personal-credentials',
  // 5 — personal / team / system and the strict personal privacy guarantee
  tiers: 'ownership-tiers-and-privacy',
  // 6 — rotate-in-place vs create-new-and-repoint, personal → team → system
  rotation: 'rotation-and-runtime-resolution',
};

export default CREDENTIALS_HELP_SECTIONS;
