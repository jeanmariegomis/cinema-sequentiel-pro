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
    console.log(`[BOOTSTRAP] ${label}: patched`);
  } else {
    console.log(`[BOOTSTRAP] ${label}: already patched`);
  }
}

patchFile(serverPath, source => {
  let out = source;

  // Latest-job fallback used when a reverse proxy returns an empty 202 body.
  if (!out.includes('// __CSP_LATEST_JOB_FALLBACK__')) {
    const marker = "app.get(\n  '/api/jobs/:id'";
    if (!out.includes(marker)) throw new Error('Route /api/jobs/:id introuvable');
    const route = `
// __CSP_LATEST_JOB_FALLBACK__
app.get('/api/jobs/latest', requirePrivateAuth, (req, res) => {
  const latest = Object.values(jobs).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];
  if (!latest) return res.status(404).json({ ok: false, error: 'NO_JOB' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json(safeJob(latest));
});
`;
    out = out.replace(marker, route + '\n' + marker);
  }

  // Make the 202 response identifiable even if its body is stripped upstream.
  if (!out.includes("res.setHeader('X-Job-Id', id)")) {
    const needle = `    return res
      .status(202)
      .json({`;
    if (!out.includes(needle)) throw new Error('Réponse 202 de /api/jobs introuvable');
    out = out.replace(needle, `    res.setHeader('X-Job-Id', id);
    res.setHeader('Cache-Control', 'no-store');

${needle}`);
  }

  // V2.0 test path. The API expects the V2 schema and 8n+1 frames.
  if (!out.includes('// __CSP_AGNES_V2_TEST_MODE__')) {
    const modelNeedle = "const MODEL =\n  'agnes-video-2.5-flash';\n\nconst LEGACY_MODEL =\n  'agnes-video-2.5-flash';";
    if (!out.includes(modelNeedle)) throw new Error('Configuration Agnes Video introuvable');
    out = out.replace(modelNeedle, `// __CSP_AGNES_V2_TEST_MODE__
const __CSP_V2_MODEL__ = 'agnes-video-v2.0';

const MODEL =
  __CSP_V2_MODEL__;

const LEGACY_MODEL =
  __CSP_V2_MODEL__;`);
  }

  if (!out.includes('// __CSP_V2_DURATION_FIX__')) {
    const oldFrameLine = '  primaryBody.num_frames = getValidLegacyFrames(requestedFrames);';
    if (!out.includes(oldFrameLine)) throw new Error('Normalisation des frames introuvable');
    const fix = `  // __CSP_V2_DURATION_FIX__
  const __CSP_V2_TARGET_FRAMES_FIX__ = Number(requestedFrames) || 121;
  const __CSP_V2_FRAMES_FIX__ = Math.max(9, Math.min(441, Math.round((__CSP_V2_TARGET_FRAMES_FIX__ - 1) / 8) * 8 + 1));
  primaryBody.num_frames = __CSP_V2_FRAMES_FIX__;
  primaryBody.frame_rate = FRAME_RATE;
  console.log('[V2.0] frame normalization: requested=' + __CSP_V2_TARGET_FRAMES_FIX__ + ', sent=' + __CSP_V2_FRAMES_FIX__ + ', duration=' + (__CSP_V2_FRAMES_FIX__ / FRAME_RATE).toFixed(3) + 's');`;
    out = out.replace(oldFrameLine, fix);
  }

  // Remove fields belonging to the V2.5 request shape and set V2.0 image fields.
  if (!out.includes('// __CSP_V2_BODY_FIX__')) {
    const postMarker = '  const response =';
    const pos = out.indexOf(postMarker);
    if (pos === -1) throw new Error('POST Agnes introuvable');
    const bodyFix = `  // __CSP_V2_BODY_FIX__
  primaryBody.model = MODEL;
  primaryBody.frame_rate = FRAME_RATE;
  delete primaryBody.mode;
  delete primaryBody.seconds;
  delete primaryBody.size;
  delete primaryBody.aspect_ratio;
  delete primaryBody.n;
  delete primaryBody.first_frame;
  delete primaryBody.last_frame;
  delete primaryBody.images;
  if (firstFrame) primaryBody.image = firstFrame;
  else if (images.length) primaryBody.image = images[0];

`;
    out = out.slice(0, pos) + bodyFix + out.slice(pos);
  }

  // Empty retry delay for create-rate-limit logic during V2 testing.
  out = out.replace('const rateLimitRetryDelays = [\n  120000\n];', 'const rateLimitRetryDelays = [];');

  return out;
}, 'server.js');

patchFile(indexPath, source => {
  let out = source;

  if (!out.includes('cinema-v13-safe-response')) {
    const needle = '        const data = await res.json();';
    if (!out.includes(needle)) throw new Error('Lecture res.json() de /api/jobs introuvable');
    const replacement = `        /* cinema-v13-safe-response */
        const responseText = await res.text();
        let data = null;
        if (responseText.trim()) {
            try { data = JSON.parse(responseText); }
            catch (parseError) {
                if (!res.ok) throw new Error('Serveur HTTP ' + res.status + ' : ' + responseText.slice(0, 800));
                addLog('Réponse serveur non JSON — récupération du job…', 'warn');
            }
        }
        if (!res.ok) {
            if (data && data.error) throw new Error(data.error);
            throw new Error('Erreur serveur HTTP ' + res.status);
        }
        if (!data || !data.id) {
            const headerJobId = res.headers.get('X-Job-Id');
            if (headerJobId) data = { id: headerJobId, status: 'queued' };
        }
        if (!data || !data.id) {
            const latestRes = await fetch('/api/jobs/latest', { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } });
            const latestText = await latestRes.text();
            let latestData = null;
            if (latestText.trim()) { try { latestData = JSON.parse(latestText); } catch (_) {} }
            if (latestRes.ok && latestData && latestData.id) data = { id: latestData.id, status: latestData.status || 'queued' };
        }
        if (!data || !data.id) throw new Error('Le serveur a créé ou accepté la demande mais n’a renvoyé aucun identifiant de job.');`;
    out = out.replace(needle, replacement);
  }

  if (!out.includes('cinema-v13-safe-poll')) {
    const needle = `        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId));
        const job = await res.json();
        if (!res.ok) throw new Error(job.error || 'Job introuvable');`;
    if (!out.includes(needle)) throw new Error('Polling /api/jobs/:id introuvable');
    const replacement = `        /* cinema-v13-safe-poll */
        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId)+'?t='+Date.now(), { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' } });
        const pollText = await res.text();
        let job = null;
        if (pollText.trim()) {
            try { job = JSON.parse(pollText); }
            catch (parseError) { if (!res.ok) throw new Error('Serveur HTTP ' + res.status + ' : ' + pollText.slice(0, 800)); addLog('Réponse de suivi non JSON — nouvelle tentative…', 'warn'); }
        } else { addLog('Réponse vide du serveur — nouvelle tentative dans 1,5 s…', 'warn'); }
        if (!res.ok) { if (job && job.error) throw new Error(job.error); throw new Error('Job HTTP ' + res.status); }
        if (!job) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }`;
    out = out.replace(needle, replacement);
  }

  return out;
}, 'public/index.html');

await import('./server.js');
