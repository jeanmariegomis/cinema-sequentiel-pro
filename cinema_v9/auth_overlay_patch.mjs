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

if (out !== source) {
  fs.writeFileSync(indexPath, out, 'utf8');
  console.log('[AUTH OVERLAY PATCH] applied');
} else {
  console.log('[AUTH OVERLAY PATCH] already applied');
}
