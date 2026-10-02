import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');

try {
  let source = fs.readFileSync(indexPath, 'utf8');

  // The server already protects / with the csp_auth cookie.
  // The old client-side auth guard could trap an authenticated user on
  // "Vérification de la session". Remove that second gate completely.
  const beforeLength = source.length;

  source = source
    .replace(/<script[^>]*id=["']auth-guard-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-status-bypass["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-gate-runtime-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<style[^>]*id=["']csp-auth-gate-runtime-fix["'][^>]*>[\s\S]*?<\/style>\s*/i, '')
    .replace(/<body([^>]*)\sclass=["']([^"']*)auth-checking([^"']*)["']/i, '<body$1 class="$2$3"');

  // Remove any static session-checking overlay left by an earlier version.
  source = source.replace(
    /<[^>]+(?:id|class)=["'][^"']*(?:auth-loading|session-loading|auth-checking|session-checking)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    ''
  );

  fs.writeFileSync(indexPath, source, 'utf8');

  console.log(
    '[AUTH FIX] client auth guard removed; server remains authoritative',
    { beforeLength, afterLength: source.length }
  );
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}

// Mobile-safe logout: never wait for the logout request before navigating.
// The server receives the cookie-clearing request in the background while the
// browser immediately returns to the login page.
const logoutScript = `
<script id="csp-logout-hotfix">
document.addEventListener('click', function(event) {
  const button = event.target && event.target.closest ? event.target.closest('#logout-btn') : null;
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  button.disabled = true;
  try {
    fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      keepalive: true
    }).catch(function() {});
  } catch (_) {}
  window.location.replace('/login.html?logout=1');
}, true);
</script>
`;

try {
  const current = fs.readFileSync(indexPath, 'utf8');
  if (!current.includes('id="csp-logout-hotfix"')) {
    fs.writeFileSync(indexPath, current.replace('</body>', logoutScript + '\n</body>'), 'utf8');
    console.log('[AUTH FIX] mobile logout hotfix installed');
  }
} catch (error) {
  console.error('[AUTH FIX] logout hotfix failed:', error?.message || error);
}
