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
    marker + '\n/* __CSP_AUTH_OVERLAY_DISABLED_V4__ */\n#auth-loading{display:none!important;visibility:hidden!important;pointer-events:none!important;}\nbody.auth-checking > :not(#auth-loading){visibility:visible!important;}'
  );
}

// Final client-side safety net: an obsolete auth script must never be able to
// re-lock the already authenticated application a few seconds after startup.
if (!out.includes('__CSP_AUTH_OVERLAY_KILL_SWITCH_V1__')) {
  const marker = '</head>';
  if (!out.includes(marker)) {
    throw new Error('AUTH FIX: head marker not found');
  }
  const guard = `\n<script id="__CSP_AUTH_OVERLAY_KILL_SWITCH_V1__">\n(function(){\n  function unlock(){\n    try{\n      document.body && document.body.classList.remove('auth-checking');\n      var el=document.getElementById('auth-loading');\n      if(el){el.style.setProperty('display','none','important');el.style.setProperty('visibility','hidden','important');el.style.setProperty('pointer-events','none','important');}\n    }catch(_){}\n  }\n  unlock();\n  document.addEventListener('DOMContentLoaded',unlock,{once:false});\n  new MutationObserver(unlock).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});\n  setInterval(unlock,1000);\n})();\n</script>\n`;
  out = out.replace(marker, guard + marker);
}

if (out !== source) {
  fs.writeFileSync(indexPath, out, 'utf8');
  console.log('[AUTH FIX] public/index.html: patched');
} else {
  console.log('[AUTH FIX] public/index.html: already patched');
}

await import(pathToFileURL(path.join(root, 'bootstrap.mjs')).href);
