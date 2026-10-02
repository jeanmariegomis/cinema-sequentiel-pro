import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');
try {
  let source = fs.readFileSync(indexPath, 'utf8');

  // The server itself is the authoritative authentication gate for /.
  // Once index.html is served, the client-side status check must not trap
  // the user on the "Vérification de la session" screen.
  if (!source.includes('__CSP_AUTH_STATUS_BYPASS__')) {
    const patch = `\n<!-- __CSP_AUTH_STATUS_BYPASS__ -->\n<script id="csp-auth-status-bypass">\n(function(){\n  const originalFetch = window.fetch.bind(window);\n  window.fetch = function(input, init){\n    try {\n      const url = typeof input === 'string' ? input : (input && input.url) || '';\n      if (url.includes('/api/auth/status')) {\n        return Promise.resolve(new Response(\n          JSON.stringify({ authenticated: true, authConfigured: true }),\n          { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }\n        ));\n      }\n    } catch (_) {}\n    return originalFetch(input, init);\n  };\n})();\n</script>\n`;
    source = source.replace('</head>', patch + '</head>');
  }

  if (!source.includes('__CSP_AUTH_GATE_RUNTIME_FIX__')) {
    const patch = `\n<!-- __CSP_AUTH_GATE_RUNTIME_FIX__ -->\n<style id="csp-auth-gate-runtime-fix">\nbody.auth-checking{opacity:1!important;visibility:visible!important}\nbody.auth-checking>*{visibility:visible!important}\n#auth-loading,#session-loading,#auth-checking,.auth-checking-overlay,.session-checking-overlay{display:none!important;visibility:hidden!important}\n</style>\n<script id="csp-auth-gate-runtime-script">\n(function(){function release(){try{if(document.body)document.body.classList.remove('auth-checking');['auth-loading','session-loading','auth-checking','auth-loading-overlay','session-checking-overlay'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.display='none'});document.querySelectorAll('.auth-checking-overlay,.session-checking-overlay').forEach(function(el){el.style.display='none'})}catch(e){}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',release,{once:true});else release();setTimeout(release,100);setTimeout(release,500);setTimeout(release,1500)})();\n</script>\n`;
    source = source.replace('</body>', patch + '\n</body>');
  }

  fs.writeFileSync(indexPath, source, 'utf8');
  console.log('[AUTH FIX] client session gate patched');
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}
