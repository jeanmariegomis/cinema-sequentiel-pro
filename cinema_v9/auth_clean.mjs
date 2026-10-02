import fs from 'fs';
import path from 'path';

const root = process.cwd();
const indexPath = path.join(root, 'public', 'index.html');

function removeBlockById(html, id) {
  const open = '<div id="' + id + '"';
  const start = html.indexOf(open);
  if (start < 0) return html;
  const end = html.indexOf('</div>', start);
  if (end < 0) return html;
  return html.slice(0, start) + html.slice(end + 6);
}

function removeTagById(html, tag, id) {
  const marker = '<' + tag + ' id="' + id + '"';
  const start = html.indexOf(marker);
  if (start < 0) return html;
  const endTag = '</' + tag + '>';
  const end = html.indexOf(endTag, start);
  if (end < 0) return html;
  return html.slice(0, start) + html.slice(end + endTag.length);
}

try {
  const original = fs.readFileSync(indexPath, 'utf8');
  let html = original;

  // Remove the old client-side session gate without touching the rest of the UI.
  html = removeTagById(html, 'style', 'auth-guard-style');
  html = removeTagById(html, 'script', 'auth-guard-script');
  html = removeBlockById(html, 'auth-loading');
  html = html.replace(/(<body\\b[^>]*?)\\s+class=["']([^"']*)auth-checking([^"']*)["']/i, '$1 class="$2$3"');

  if (html !== original) {
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('[AUTH CLEAN] session overlay removed');
  } else {
    console.log('[AUTH CLEAN] no session overlay found');
  }
} catch (error) {
  console.error('[AUTH CLEAN] failed:', error?.message || error);
}

await import('./bootstrap.mjs');
