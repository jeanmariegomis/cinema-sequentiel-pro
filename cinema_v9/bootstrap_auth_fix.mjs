import fs from 'fs';
import path from 'path';

const indexPath = path.join(process.cwd(), 'public', 'index.html');

try {
  let source = fs.readFileSync(indexPath, 'utf8');

  // The server already protects / with the csp_auth cookie.
  // The old client-side auth guard could trap an authenticated user on
  // "Vérification de la session". Remove that second gate completely.
  const beforeLength = source.length;

  source = source
    .replace(/<script[^>]*id=["']auth-guard-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-status-bypass["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<script[^>]*id=["']csp-auth-gate-runtime-script["'][^>]*>[\s\S]*?<\/script>\s*/i, '')
    .replace(/<style[^>]*id=["']csp-auth-gate-runtime-fix["'][^>]*>[\s\S]*?<\/style>\s*/i, '')
    .replace(/<body([^>]*)\sclass=["']([^"']*)auth-checking([^"']*)["']/i, '<body$1 class="$2$3"');

  // Remove any static session-checking overlay left by an earlier version.
  source = source.replace(
    /<[^>]+(?:id|class)=["'][^"']*(?:auth-loading|session-loading|auth-checking|session-checking)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    ''
  );

  fs.writeFileSync(indexPath, source, 'utf8');

  console.log(
    '[AUTH FIX] client auth guard removed; server remains authoritative',
    { beforeLength, afterLength: source.length }
  );
} catch (error) {
  console.error('[AUTH FIX] failed:', error?.message || error);
}
