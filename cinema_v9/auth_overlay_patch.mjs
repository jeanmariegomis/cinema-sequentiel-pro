import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');
const source = fs.readFileSync(indexPath, 'utf8');

let out = source;

const oldShowApp = `  function showApp(){\n    document.body.classList.remove('auth-checking');\n    if(loading) loading.remove();\n    logAuth('Session valide — application déverrouillée','success');\n  }`;

const newShowApp = `  function showApp(){\n    document.body.classList.remove('auth-checking');\n    const authLoading = document.getElementById('auth-loading');\n    if(authLoading) authLoading.remove();\n    logAuth('Session valide — application déverrouillée','success');\n  }`;

if (out.includes(oldShowApp)) {
  out = out.replace(oldShowApp, newShowApp);
}

const styleMarker = 'body.auth-checking > :not(#auth-loading){visibility:hidden!important;}';
const styleFix = styleMarker + '\nbody:not(.auth-checking) #auth-loading{display:none!important;}';

if (!out.includes('body:not(.auth-checking) #auth-loading{display:none!important;}')) {
  if (!out.includes(styleMarker)) {
    throw new Error('AUTH_OVERLAY_PATCH: auth guard style target not found');
  }
  out = out.replace(styleMarker, styleFix);
}

// The server private gate already validates csp_auth before / is served.
// Therefore a page that reached index.html is authenticated. Do not perform
// a second client-side session gate that can leave the UI stuck behind the
// verification overlay on mobile browsers. Keep the server as the authority.
const trustServerMarker = '/* __CSP_AUTH_TRUST_SERVER_GATE_V1__ */';
const checkMarker = '  async function check(){';
const trustedCheck = `  async function check(){\n    ${trustServerMarker}\n    showApp();\n    return;`;

if (!out.includes(trustServerMarker)) {
  if (!out.includes(checkMarker)) {
    throw new Error('AUTH_OVERLAY_PATCH: check function target not found');
  }
  out = out.replace(checkMarker, trustedCheck);
}

// Defensive fallback for any legacy overlay markup. This does not grant access;
// the server private gate has already authenticated the request before serving
// this document.
const unlockMarker = '/* __CSP_AUTH_OVERLAY_FORCE_UNLOCK_V3__ */';
if (!out.includes(unlockMarker)) {
  const unlockScript = `\n<script>\n${unlockMarker}\n(function(){\n  function unlock(){\n    try{\n      document.body.classList.remove('auth-checking');\n      const overlay=document.getElementById('auth-loading');\n      if(overlay) overlay.remove();\n    }catch(_){}\n  }\n  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',unlock,{once:true});\n  else unlock();\n})();\n</script>\n`;
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
