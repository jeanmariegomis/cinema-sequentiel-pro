import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');

try {
  let source = fs.readFileSync(indexPath, 'utf8');
  const beforeLength = source.length;

  // The server is the only authentication authority. Remove every old
  // client-side auth gate that can trap an authenticated user.
  source = source
    .replace(/<script[^>]*id=["']auth-guard-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-status-bypass["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-gate-runtime-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<style[^>]*id=["']csp-auth-gate-runtime-fix["'][^>]*>[\s\S]*?<\/style>\s*/i, '')
    .replace(/<body([^>]*)\sclass=["']([^"']*)auth-checking([^"']*)["']/i, '<body$1 class="$2$3"')
    // Remove the original async logout handler. It awaited fetch() and could
    // leave the mobile browser apparently frozen when the API is slow.
    .replace(/<script[^>]*id=["']logout-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '');

  // Remove static session overlays left by older versions.
  source = source.replace(
    /<[^>]+(?:id|class)=["'][^"']*(?:auth-loading|session-loading|auth-checking|session-checking)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    ''
  );

  const logoutScript = `
<script id="csp-logout-hotfix">
(function () {
  if (window.__cspLogoutHotfixInstalled) return;
  window.__cspLogoutHotfixInstalled = true;

  function isLogoutControl(el) {
    if (!el || !(el instanceof Element)) return false;
    const node = el.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (!node) return false;
    const signature = [
      node.id || '',
      node.getAttribute('name') || '',
      node.getAttribute('aria-label') || '',
      node.getAttribute('title') || '',
      node.textContent || '',
      node.value || ''
    ].join(' ').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    return /\\b(deconnexion|logout|se deconnecter|sign out|log out)\\b/i.test(signature);
  }

  function logoutNow(event) {
    if (!isLogoutControl(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    const target = event.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (target) target.disabled = true;

    // Fire-and-forget: navigation must never wait for the API response.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/auth/logout', new Blob([], { type: 'application/json' }));
      } else {
        fetch('/api/auth/logout', {
          method: 'POST', credentials: 'include', cache: 'no-store', keepalive: true
        }).catch(function () {});
      }
    } catch (_) {}

    window.location.replace('/login.html?logout=1');
  }

  // Capture phase runs before application bubble handlers.
  document.addEventListener('click', logoutNow, true);
  document.addEventListener('pointerup', logoutNow, true);
})();
</script>
`;

  // Always replace any previous generated hotfix so deployment gets exactly
  // one known logout handler. This is intentionally idempotent.
  source = source.replace(/<script[^>]*id=["']csp-logout-hotfix["'][^>]*>[\s\S]*?<\/script>\s*/i, '');
  source = source.replace('</body>', logoutScript + '\n</body>');

  fs.writeFileSync(indexPath, source, 'utf8');
  console.log('[AUTH FIX] auth gate removed and logout replaced with immediate beacon redirect', {
    beforeLength,
    afterLength: source.length
  });
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}
