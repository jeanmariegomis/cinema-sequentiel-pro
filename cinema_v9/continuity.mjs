import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const indexPath = path.join(root, 'public', 'index.html');

const source = fs.readFileSync(indexPath, 'utf8');
let out = source;

// The server has already authenticated the request before index.html is served.
// Do not keep a permanent client-side visual lock around the application.
out = out.replace(/<body\s+class=["']auth-checking["']>/i, '<body>');

// Disable the obsolete overlay without installing observers, polling loops, or
// other runtime hooks. The previous MutationObserver watched class/style
// mutations while its own unlock() function changed style, which could create
// a self-triggering mutation loop and freeze mobile browsers.
if (!out.includes('__CSP_AUTH_OVERLAY_DISABLED_V5__')) {
  const marker = '<style id="auth-guard-style">';
  if (!out.includes(marker)) throw new Error('AUTH FIX: auth guard style target not found');
  out = out.replace(
    marker,
    marker + '\n/* __CSP_AUTH_OVERLAY_DISABLED_V5__ */\n#auth-loading{display:none!important;visibility:hidden!important;pointer-events:none!important;}\nbody.auth-checking > :not(#auth-loading){visibility:visible!important;}'
  );
}

// Safe one-shot cleanup only. No MutationObserver and no setInterval.
if (!out.includes('__CSP_AUTH_OVERLAY_KILL_SWITCH_V2__')) {
  const marker = '</head>';
  if (!out.includes(marker)) throw new Error('AUTH FIX: head marker not found');
  const guard = `\n<script id="__CSP_AUTH_OVERLAY_KILL_SWITCH_V2__">\n(function(){\n  function unlock(){\n    try{\n      if(document.body) document.body.classList.remove('auth-checking');\n      var el=document.getElementById('auth-loading');\n      if(el){\n        el.style.display='none';\n        el.setAttribute('aria-hidden','true');\n      }\n    }catch(_){}\n  }\n  unlock();\n  document.addEventListener('DOMContentLoaded',unlock,{once:true});\n  setTimeout(unlock,1500);\n  setTimeout(unlock,4000);\n})();\n</script>\n`;
  out = out.replace(marker, guard + marker);
}

if (out !== source) {
  fs.writeFileSync(indexPath, out, 'utf8');
  console.log('[AUTH FIX] public/index.html: patched without runtime observer');
} else {
  console.log('[AUTH FIX] public/index.html: already patched');
}

await import(pathToFileURL(path.join(root, 'bootstrap.mjs')).href);
