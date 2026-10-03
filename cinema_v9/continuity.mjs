import fs from 'fs';
import path from 'path';

const root = process.cwd();
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

if (!source.includes('// __CSP_AUTO_CONTINUITY_V2__')) {
  throw new Error('[CONTINUITY] server.js n\'intègre pas le moteur de continuité natif. Démarrage annulé.');
}

console.log('[CONTINUITY] Moteur natif V2 détecté dans server.js. Aucun patch runtime fragile ne sera appliqué.');

// Load the global prompt guard BEFORE bootstrap/server.js so every Agnes video
// request receives the same character/animal/action constraints. This leaves
// auth, polling, download, progress and native continuity untouched.
await import('./prompt_guard.mjs');

await import('./bootstrap.mjs');
