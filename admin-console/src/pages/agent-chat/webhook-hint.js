// Copy for the HTTP webhook section of TriggerForm (#2680). The hook server
// (orchestrator/hook-auth.js) accepts the trigger secret two ways: a plain
// X-Hook-Secret header, or — for GitHub webhooks, which cannot send custom
// headers — the secret stored as the webhook's "Secret", verified through
// GitHub's X-Hub-Signature-256 HMAC. Pure, so the copy is node:test-covered
// while the JSX stays uncovered (#651).

export const WEBHOOK_PORT = 4003;

// A copy-pasteable generic call. The secret is never inlined — the user pastes it.
export function webhookCurlExample(webhookPath) {
  return `curl -X POST -H "X-Hook-Secret: <secret>" http://<host>:${WEBHOOK_PORT}${webhookPath}`;
}

export const WEBHOOK_GITHUB_HINT =
  'GitHub webhook: paste the secret into the webhook\'s "Secret" field, with this endpoint as Payload URL — '
  + 'GitHub signs each delivery (X-Hub-Signature-256), which is accepted instead of the header. '
  + 'GitHub\'s ping delivery is acknowledged without firing the trigger.';

export const WEBHOOK_SECRET_WARNING =
  'Anyone with the secret can fire this trigger — copy it once and rotate via the ↻ button.';
