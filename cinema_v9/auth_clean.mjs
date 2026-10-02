import fs from 'fs';
import path from 'path';

const root = process.cwd();
const indexPath = path.join(root, 'public', 'index.html');

function removeScriptById(html, id) {
  const re = new RegExp(`<script\\s+id=["']${id}["'][^>]*>[\\s\\S]*?<\\/script>\\s*`, 'i');
  return html.replace(re, '');
}

function removeStyleById(html, id) {
  const re = new RegExp(`<style\\s+id=["']${id}["'][^>]*>[\\s\\S]*?<\\/style>\\s*`, 'i');
  return html.replace(re, '');
}

function removeElementById(html, id) {
  const startRe = new RegExp(`<([a-zA-Z][\\w:-]*)[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const match = startRe.exec(html);
  if (!match) return html;

  const tag = match[1];
  const start = match.index;
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokenRe.lastIndex = start;

  let depth = 0;
  let token;
  while ((token = tokenRe.exec(html))) {
    if (/^<\\//.test(token[0])) {
      depth--;
      if (depth === 0) {
        return html.slice(0, start) + html.slice(tokenRe.lastIndex);
      }
    } else if (!/\\/>$/.test(token[0])) {
      depth++;
    }
  }

  return html;
}

try {
  let html = fs.readFileSync(indexPath, 'utf8');
  const before = html.length;

  html = removeStyleById(html, 'auth-guard-style');
  html = removeScriptById(html, 'auth-guard-script');
  html = removeElementById(html, 'auth-loading');
  html = html.replace(
    /(<body\\b[^>]*?)\\s+class=["']([^"']*)auth-checking([^"']*)["']/i,
    '$1 class="$2$3"'
  );

  if (html !== fs.readFileSync(indexPath, 'utf8')) {
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('[AUTH CLEAN] client session gate removed:', before, '->', html.length);
  } else {
    console.log('[AUTH CLEAN] no client session gate found');
  }
} catch (error) {
  console.error('[AUTH CLEAN] failed:', error?.message || error);
}

// Continue with the existing production bootstrap so all existing
// generation/job compatibility logic remains active.
await import('./bootstrap.mjs');
