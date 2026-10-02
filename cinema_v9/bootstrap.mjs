import fs from 'fs';
import path from 'path';

const root = process.cwd();
const serverPath = path.join(root, 'server.js');
const indexPath = path.join(root, 'public', 'index.html');

function patchFile(filePath, transform, label) {
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = transform(original);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log('[BOOTSTRAP] ' + label + ': patched');
  } else {
    console.log('[BOOTSTRAP] ' + label + ': already patched');
  }
}

// Keep the existing server/job compatibility patches, but make authentication
// authoritative on the server instead of depending on a client-side polling gate.
patchFile(serverPath, source => {
  let out = source;

  if (!out.includes('// __CSP_AUTH_ROOT_GUARD__')) {
    const oldRoot = `app.get(\n  '/',\n  (req, res) => {\n\n    return res.sendFile(\n      path.join(\n        process.cwd(),\n        'public',\n        'index.html'\n      )\n    );\n  }\n);`;

    const newRoot = `// __CSP_AUTH_ROOT_GUARD__\napp.get(\n  '/',\n  requirePrivateAuth,\n  (req, res) => {\n    res.setHeader('Cache-Control', 'no-store');\n    return res.sendFile(\n      path.join(\n        process.cwd(),\n        'public',\n        'index.html'\n      )\n    );\n  }\n);`;

    if (out.includes(oldRoot)) out = out.replace(oldRoot, newRoot);
  }

  if (!out.includes('// __CSP_AUTH_PUBLIC_LOGIN__')) {
    const oldCatchall = `app.get(\n  /^(?!\\/api\\/).*/,\n  (req, res) => {\n\n    return res.sendFile(\n      path.join(\n        process.cwd(),\n        'public',\n        'index.html'\n      )\n    );\n  }\n);`;

    const newCatchall = `// __CSP_AUTH_PUBLIC_LOGIN__\napp.get(\n  /^(?!\\/api\\/).*/,\n  (req, res, next) => {\n    if (req.path === '/login.html') {\n      res.setHeader('Cache-Control', 'no-store');\n      return res.sendFile(path.join(process.cwd(), 'public', 'login.html'));\n    }\n\n    return requirePrivateAuth(req, res, () => {\n      res.setHeader('Cache-Control', 'no-store');\n      return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));\n    });\n  }\n);`;

    if (out.includes(oldCatchall)) out = out.replace(oldCatchall, newCatchall);
  }

  return out;
}, 'server.js');

// Remove ONLY the known client authentication gate. No broad regex and no
// rewriting of application functionality. The server is now authoritative.
patchFile(indexPath, source => {
  let out = source;

  out = out.replace(
    /<script\\s+id=["']auth-guard-script["'][^>]*>[\\s\\S]*?<\\/script>\\s*/i,
    ''
  );

  out = out.replace(
    /<style\\s+id=["']auth-guard-style["'][^>]*>[\\s\\S]*?<\\/style>\\s*/i,
    ''
  );

  out = out.replace(
    /<[^>]+id=["']auth-loading["'][^>]*>[\\s\\S]*?<\\/[^>]+>\\s*/i,
    ''
  );

  out = out.replace(
    /(<body[^>]*?)\\s+class=["']([^"']*)auth-checking([^"']*)["']/i,
    '$1 class="$2$3"'
  );

  return out;
}, 'public/index.html');

await import('./server.js');
