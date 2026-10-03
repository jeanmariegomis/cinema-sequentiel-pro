import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');
const source = fs.readFileSync(indexPath, 'utf8');

let out = source;

const oldShowApp = `  function showApp(){\n    document.body.classList.remove('auth-checking');\n    if(loading) loading.remove();\n    logAuth('Session valide — application déverrouillée','success');\n  }`;

const newShowApp = `  function showApp(){\n    document.body.classList.remove('auth-checking');\n    const authLoading = document.getElementById('auth-loading');\n    if(authLoading) authLoading.remove();\n    logAuth('Session valide — application déverrouillée','success');\n  }`;

if (out.includes(oldShowApp)) {
  out = out.replace(oldShowApp, newShowApp);
} else if (!out.includes("const authLoading = document.getElementById('auth-loading');")) {
  throw new Error('AUTH_OVERLAY_PATCH: showApp target not found');
}

const styleMarker = 'body.auth-checking > :not(#auth-loading){visibility:hidden!important;}';
const styleFix = styleMarker + '\nbody:not(.auth-checking) #auth-loading{display:none!important;}';

if (!out.includes('body:not(.auth-checking) #auth-loading{display:none!important;}')) {
  if (!out.includes(styleMarker)) {
    throw new Error('AUTH_OVERLAY_PATCH: auth guard style target not found');
  }
  out = out.replace(styleMarker, styleFix);
}

// Final defensive unlock: the screenshot state proves authentication succeeded
// (the protected application and its logout control are already rendered), but
// the visual auth overlay can remain stuck. In that state, unlock the page
// without touching the authentication request, cookie, video pipeline, or job state.
const unlockMarker = '/* __CSP_AUTH_OVERLAY_FORCE_UNLOCK_V2__ */';
if (!out.includes(unlockMarker)) {
  const unlockScript = `\n<script>\n${unlockMarker}\n(function(){\n  function forceUnlockIfAuthenticated(){\n    try {\n      const buttons = Array.from(document.querySelectorAll('button'));\n      const authenticatedUi = buttons.some(function(btn){\n        return /déconnecter|deconnecter/i.test((btn.textContent || '').trim());\n      });\n      if (!authenticatedUi) return false;\n      document.body.classList.remove('auth-checking');\n      const overlay = document.getElementById('auth-loading');\n      if (overlay) overlay.remove();\n      return true;\n    } catch (_) { return false; }\n  }\n  if (forceUnlockIfAuthenticated()) return;\n  const observer = new MutationObserver(function(){\n    if (forceUnlockIfAuthenticated()) observer.disconnect();\n  });\n  observer.observe(document.documentElement, {childList:true, subtree:true});\n  setTimeout(function(){\n    forceUnlockIfAuthenticated();\n    observer.disconnect();\n  }, 15000);\n})();\n</script>\n`;
  const bodyClose = '</body>';
  if (!out.includes(bodyClose)) throw new Error('AUTH_OVERLAY_PATCH: </body> target not found');
  out = out.replace(bodyClose, unlockScript + bodyClose);
}

if (out !== source) {
  fs.writeFileSync(indexPath, out, 'utf8');
  console.log('[AUTH OVERLAY PATCH] applied');
} else {
  console.log('[AUTH OVERLAY PATCH] already applied');
}
