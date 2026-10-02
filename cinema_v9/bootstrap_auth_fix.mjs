import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');

function stripAuthOverlay(source) {
  let out = source;
  out = out.replace(/<style[^>]*id=["']auth-guard-style["'][^>]*>[\s\S]*?<\/style>\s*/gi, '');
  out = out.replace(/<div\s+id=["']auth-loading["'][^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*/i, '');
  if (out.includes('id="auth-loading"') || out.includes("id='auth-loading'")) {
    out = out.replace(/<div\s+id=["']auth-loading["'][^>]*>[\s\S]*?<\/div>\s*(?=<(?:header|main|div)\b)/i, '');
  }
  return out
    .replace(/<script[^>]*id=["']auth-guard-script["'][^>]*>[\s\S]*?<\/script>\s*/gi, '')
    .replace(/<script[^>]*id=["']csp-auth-status-bypass["'][^>]*>[\s\S]*?<\/script>\s*/gi, '')
    .replace(/<script[^>]*id=["']csp-auth-gate-runtime-script["'][^>]*>[\s\S]*?<\/script>\s*/gi, '')
    .replace(/<style[^>]*id=["']csp-auth-gate-runtime-fix["'][^>]*>[\s\S]*?<\/style>\s*/gi, '')
    .replace(/<body([^>]*)\sclass=["']([^"']*)auth-checking([^"']*)["']/i, '<body$1 class="$2$3"')
    .replace(/<script[^>]*id=["']logout-script["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
}

try {
  let source = fs.readFileSync(indexPath, 'utf8');
  const beforeLength = source.length;
  source = stripAuthOverlay(source);

  const logoutScript = `
<script id="csp-logout-navigation-fix">
(function () {
  if (window.__cspLogoutNavigationFix) return;
  window.__cspLogoutNavigationFix = true;
  function isLogoutControl(el) {
    if (!el || !(el instanceof Element)) return false;
    const node = el.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (!node) return false;
    const signature = [node.id || '', node.getAttribute('name') || '', node.getAttribute('aria-label') || '', node.getAttribute('title') || '', node.textContent || '', node.value || ''].join(' ').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    return /\\b(deconnexion|logout|se deconnecter|sign out|log out)\\b/i.test(signature);
  }
  document.addEventListener('click', function (event) {
    if (!isLogoutControl(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    const node = event.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (node) node.disabled = true;
    window.location.assign('/api/auth/logout');
  }, true);
})();
</script>
`;

  source = source.replace(/<script[^>]*id=["']csp-logout-(?:hotfix|navigation-fix)["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
  source = source.replace('</body>', logoutScript + '\n</body>');
  fs.writeFileSync(indexPath, source, 'utf8');

  console.log('[AUTH FIX] client auth overlay removed; server-navigation logout installed', {
    beforeLength,
    afterLength: source.length,
    overlayRemaining: /id=["']auth-loading["']/.test(source),
    guardStyleRemaining: /id=["']auth-guard-style["']/.test(source),
    guardScriptRemaining: /id=["']auth-guard-script["']/.test(source)
  });
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}
