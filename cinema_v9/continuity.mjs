import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const indexPath = path.join(root, 'public', 'index.html');

const source = fs.readFileSync(indexPath, 'utf8');
let out = source;

// The server has already completed the login redirect before this page is
// reached. The old client-side overlay had no reliable release path and could
// remain forever on mobile browsers. Remove the redundant visual gate.
out = out.replace('<body class="auth-checking">', '<body>');

if (!out.includes('/* __CSP_AUTH_OVERLAY_DISABLED_V4__ */')) {
  const marker = '<style id="auth-guard-style">';
  if (!out.includes(marker)) {
    throw new Error('AUTH FIX: auth guard style target not found');
  }
  out = out.replace(
    marker,
    marker + '\n/* __CSP_AUTH_OVERLAY_DISABLED_V4__ */\n#auth-loading{display:none!important;}'
  );
}

if (out !== source) {
  fs.writeFileSync(indexPath, out, 'utf8');
  console.log('[AUTH FIX] public/index.html: patched');
} else {
  console.log('[AUTH FIX] public/index.html: already patched');
}

await import(pathToFileURL(path.join(root, 'bootstrap.mjs')).href);
