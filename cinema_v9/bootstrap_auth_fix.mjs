import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');
try {
  let source = fs.readFileSync(indexPath, 'utf8');
  if (!source.includes('__CSP_AUTH_GATE_RUNTIME_FIX__')) {
    const patch = `\n<!-- __CSP_AUTH_GATE_RUNTIME_FIX__ -->\n<style id="csp-auth-gate-runtime-fix">\nbody.auth-checking{opacity:1!important;visibility:visible!important}\nbody.auth-checking>*{visibility:visible!important}\n#auth-loading,#session-loading,#auth-checking,.auth-checking-overlay,.session-checking-overlay{display:none!important;visibility:hidden!important}\n</style>\n<script id="csp-auth-gate-runtime-script">\n(function(){function release(){try{if(document.body)document.body.classList.remove('auth-checking');['auth-loading','session-loading','auth-checking','auth-loading-overlay','session-checking-overlay'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.display='none'});document.querySelectorAll('.auth-checking-overlay,.session-checking-overlay').forEach(function(el){el.style.display='none'})}catch(e){}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',release,{once:true});else release();setTimeout(release,100);setTimeout(release,500);setTimeout(release,1500)})();\n</script>\n`;
    source = source.replace('</body>', patch + '\n</body>');
    fs.writeFileSync(indexPath, source, 'utf8');
    console.log('[AUTH FIX] client session gate released');
  }
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}
