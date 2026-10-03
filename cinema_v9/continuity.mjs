import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

// The deterministic V2 baseline already contains its own stable generation
// path. The old runtime patcher expected a very specific server.js text block
// that no longer exists in this baseline. Never mutate server.js at startup
// when that exact compatibility point is absent: doing so can make Render
// fail before the application starts.
if (source.includes('// __CSP_AUTO_CONTINUITY_V2__')) {
  console.log('[CONTINUITY] V2 continuity hooks already present; no startup patch required.');
} else {
  console.log('[CONTINUITY] Stable V2 baseline detected; startup patch skipped to preserve the exact server.js generation logic.');
}

await import(pathToFileURL(path.join(root, 'bootstrap.mjs')).href);
