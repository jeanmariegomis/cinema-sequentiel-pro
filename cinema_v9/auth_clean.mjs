import fs from 'fs';
import path from 'path';

const root = process.cwd();
const indexPath = path.join(root, 'public', 'index.html');
const serverPath = path.join(root, 'server.js');

function removeScriptById(html, id) {
  const re = new RegExp(`<script\\s+id=["']${id}["'][^>]*>[\\s\\S]*?<\\/script>\\s*`, 'i');
  return html.replace(re, '');
}

function removeStyleById(html, id) {
  const re = new RegExp(`<style\\s+id=["']${id}["'][^>]*>[\\s\\S]*?<\\/style>\\s*`, 'i');
  return html.replace(re, '');
}

function removeElementById(html, id) {
  const startRe = new RegExp(`<([a-zA-Z][\\w:-]*)[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const match = startRe.exec(html);
  if (!match) return html;

  const tag = match[1];
  const start = match.index;
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokenRe.lastIndex = start;

  let depth = 0;
  let token;
  while ((token = tokenRe.exec(html))) {
    if (/^<\\//.test(token[0])) {
      depth--;
      if (depth === 0) {
        return html.slice(0, start) + html.slice(tokenRe.lastIndex);
      }
    } else if (!/\\/>$/.test(token[0])) {
      depth++;
    }
  }

  return html;
}

try {
  let html = fs.readFileSync(indexPath, 'utf8');
  const before = html.length;
  const original = html;

  html = removeStyleById(html, 'auth-guard-style');
  html = removeScriptById(html, 'auth-guard-script');
  html = removeElementById(html, 'auth-loading');
  html = html.replace(
    /(<body\\b[^>]*?)\\s+class=["']([^"']*)auth-checking([^"']*)["']/i,
    '$1 class="$2$3"'
  );

  if (html !== original) {
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('[AUTH CLEAN] client session gate removed:', before, '->', html.length);
  } else {
    console.log('[AUTH CLEAN] no client session gate found');
  }
} catch (error) {
  console.error('[AUTH CLEAN] index cleanup failed:', error?.message || error);
}

try {
  let server = fs.readFileSync(serverPath, 'utf8');

  if (!server.includes('// __CSP_SERVER_AUTH_GATE__')) {
    const marker = '// APPLICATION';
    const middleware = `// __CSP_SERVER_AUTH_GATE__\n// The server is authoritative for page access. This removes the need for a\n// client-side polling overlay that can freeze the UI when /api/auth/status hangs.\napp.use((req, res, next) => {\n  if (req.method !== 'GET') return next();\n  if (req.path === '/login.html') return next();\n  if (req.path.startsWith('/api/')) return next();\n\n  if (validAuthToken(getCookie(req, 'csp_auth'))) return next();\n\n  return res.redirect(303, '/login.html?next=/');\n});\n\n`;

    if (server.includes(marker)) {
      server = server.replace(marker, middleware + marker);
      fs.writeFileSync(serverPath, server, 'utf8');
      console.log('[AUTH CLEAN] server-side page gate installed');
    } else {
      console.warn('[AUTH CLEAN] server application marker not found');
    }
  } else {
    console.log('[AUTH CLEAN] server-side page gate already installed');
  }
} catch (error) {
  console.error('[AUTH CLEAN] server patch failed:', error?.message || error);
}

// Continue with the existing production bootstrap so all existing
// generation/job compatibility logic remains active.
await import('./bootstrap.mjs');
