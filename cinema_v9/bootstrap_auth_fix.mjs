import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');

try {
  let source = fs.readFileSync(indexPath, 'utf8');
  const beforeLength = source.length;

  // The server already protects / with the csp_auth cookie.
  // Remove the old client-side auth gate so an authenticated user cannot be
  // trapped on "Vérification de la session".
  source = source
    .replace(/<script[^>]*id=["']auth-guard-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-status-bypass["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-gate-runtime-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<style[^>]*id=["']csp-auth-gate-runtime-fix["'][^>]*>[\s\S]*?<\/style>\s*/i, '')
    .replace(/<body([^>]*)\sclass=["']([^"']*)auth-checking([^"']*)["']/i, '<body$1 class="$2$3"');

  source = source.replace(
    /<[^>]+(?:id|class)=["'][^"']*(?:auth-loading|session-loading|auth-checking|session-checking)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    ''
  );

  fs.writeFileSync(indexPath, source, 'utf8');
  console.log('[AUTH FIX] client auth guard removed', { beforeLength, afterLength: source.length });
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}

// Mobile-safe logout. Do NOT depend on a guessed element id: the handler
// recognizes the actual logout control by common selectors and visible text.
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

  document.addEventListener('click', logoutNow, true);
  document.addEventListener('pointerup', logoutNow, true);
})();
</script>
`;

try {
  const current = fs.readFileSync(indexPath, 'utf8');
  if (!current.includes('id="csp-logout-hotfix"')) {
    fs.writeFileSync(indexPath, current.replace('</body>', logoutScript + '\n</body>'), 'utf8');
    console.log('[AUTH FIX] intelligent mobile logout hotfix installed');
  }
} catch (error) {
  console.error('[AUTH FIX] logout hotfix failed:', error?.message || error);
}
