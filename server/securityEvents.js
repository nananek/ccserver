// Security-relevant account events (security audit F2 remediation): a new
// passkey registered, a passkey added to the GPG vault, a vault created or
// deleted. Each of these is exactly what a session thief would do first, so
// the owner should hear about it even when it was not them.
//
// Always logged to the server log. Additionally delivered through the
// regular notify channels (ws/notify.js: Discord/webhooks) -- imported
// lazily so auth/vault routes don't statically pull in the sandbox module
// graph, and skipped under `node --test` so test runs never post to a real
// webhook configured on the developer's machine.

export function reportSecurityEvent(title, body) {
  console.warn(`[security] ${title}: ${body}`);
  if (process.env.NODE_TEST_CONTEXT) return;
  import('./ws/notify.js')
    .then(({ sendNotification }) => sendNotification({ title: `[ccserver security] ${title}`, body, level: 'warning' }))
    .catch((err) => console.warn(`[security] notification delivery failed: ${err.message}`));
}
