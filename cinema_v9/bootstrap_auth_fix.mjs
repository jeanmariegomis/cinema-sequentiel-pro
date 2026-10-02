import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');
const serverPath = path.join(process.cwd(), 'server.js');

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
    .replace(/<script[^>]*id=["']logout-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '');

  source = source.replace(
    /<[^>]+(?:id|class)=["'][^"']*(?:auth-loading|session-loading|auth-checking|session-checking)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    ''
  );

  fs.writeFileSync(indexPath, source, 'utf8');
  console.log('[AUTH FIX] auth gate cleaned', { beforeLength, afterLength: source.length });
} catch (error) {
  console.error('[AUTH FIX] index cleanup failed:', error?.message || error);
}

// ============================================================
// Deterministic logout route
// ============================================================
// The previous client implementation raced: it sent an async logout request
// and navigated to /login.html before the cookie was necessarily cleared.
// That could send the user back through the private gate. Install a GET route
// that clears the cookie and redirects in ONE browser navigation.
try {
  let server = fs.readFileSync(serverPath, 'utf8');
  const marker = "  app.post(\n    '/api/auth/logout',";

  if (!server.includes("app.get(\n    '/api/auth/logout'")) {
    const pos = server.indexOf(marker);
    if (pos !== -1) {
      const route = `  app.get(\n    '/api/auth/logout',\n    (req, res) => {\n      res.setHeader(\n        'Cache-Control',\n        'no-store'\n      );\n      res.setHeader(\n        'Set-Cookie',\n        'csp_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'\n      );\n      return res.redirect(303, '/login.html?logout=1');\n    }\n  );\n\n`;
      server = server.slice(0, pos) + route + server.slice(pos);
      fs.writeFileSync(serverPath, server, 'utf8');
      console.log('[AUTH FIX] deterministic GET logout route installed');
    } else {
      console.warn('[AUTH FIX] POST logout route marker not found; server unchanged');
    }
  } else {
    console.log('[AUTH FIX] deterministic GET logout route already installed');
  }
} catch (error) {
  console.error('[AUTH FIX] server logout patch failed:', error?.message || error);
}

// ============================================================
// Client logout: one navigation, no fetch, no beacon, no race
// ============================================================
const logoutScript = `
<script id="csp-logout-hotfix">
(function () {
  if (window.__cspLogoutHotfixInstalled) return;
  window.__cspLogoutHotfixInstalled = true;

  function getLogoutControl(target) {
    if (!target) return null;
    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || !el.closest) return null;
    const node = el.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (!node) return null;

    const signature = [
      node.id || '',
      node.getAttribute('name') || '',
      node.getAttribute('aria-label') || '',
      node.getAttribute('title') || '',
      node.textContent || '',
      node.value || ''
    ].join(' ').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');

    return /\\b(deconnexion|se deconnecter|logout|log out|sign out)\\b/i.test(signature)
      ? node
      : null;
  }

  function handleLogout(event) {
    const button = getLogoutControl(event.target);
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    button.disabled = true;

    // Do not use fetch() or sendBeacon(). Browser navigation waits for the
    // server response, receives Set-Cookie, then follows the 303 to login.
    window.location.replace('/api/auth/logout');
  }

  document.addEventListener('click', handleLogout, true);
})();
</script>
`;

try {
  let source = fs.readFileSync(indexPath, 'utf8');
  source = source.replace(/<script[^>]*id=["']csp-logout-hotfix["'][^>]*>[\s\S]*?<\/script>\s*/i, '');
  source = source.replace('</body>', logoutScript + '\n</body>');
  fs.writeFileSync(indexPath, source, 'utf8');
  console.log('[AUTH FIX] deterministic logout handler installed');
} catch (error) {
  console.error('[AUTH FIX] logout handler install failed:', error?.message || error);
}
