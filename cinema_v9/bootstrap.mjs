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

patchFile(serverPath, source => {
  let out = source;

  if (!out.includes('// __CSP_LATEST_JOB_FALLBACK__')) {
    const marker = "app.get(\n  '/api/jobs/:id'";
    if (out.includes(marker)) {
      const route = "\n// __CSP_LATEST_JOB_FALLBACK__\napp.get('/api/jobs/latest', requirePrivateAuth, (req, res) => {\n  const latest = Object.values(jobs).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];\n  if (!latest) return res.status(404).json({ ok: false, error: 'NO_JOB' });\n  res.setHeader('Cache-Control', 'no-store');\n  return res.json(safeJob(latest));\n});\n";
      out = out.replace(marker, route + '\n' + marker);
    }
  }

  // processJobs() is synchronous; launch it without .catch().
  if (!out.includes('// __CSP_PROCESSJOBS_SAFE_LAUNCH__')) {
    const oldLaunch = "setImmediate(() => {\n    processJobs().catch(error => {\n        console.error('[WORKER LAUNCH ERROR]', error);\n    });\n});";
    const newLaunch = "// __CSP_PROCESSJOBS_SAFE_LAUNCH__\n    setImmediate(() => {\n      try {\n        processJobs();\n      } catch (error) {\n        console.error('[WORKER LAUNCH ERROR]', error);\n      }\n    });";
    if (out.includes(oldLaunch)) {
      out = out.replace(oldLaunch, newLaunch);
    } else {
      console.warn('[BOOTSTRAP] processJobs launch pattern not found; leaving server unchanged');
    }
  }

  if (!out.includes("res.setHeader('X-Job-Id', id)")) {
    const responseNeedle = "    return res\n      .status(202)\n      .json({";
    if (out.includes(responseNeedle)) {
      out = out.replace(responseNeedle, "    res.setHeader('X-Job-Id', id);\n    res.setHeader('Cache-Control', 'no-store');\n\n" + responseNeedle);
    }
  }

  if (!out.includes('// __CSP_AGNES_V2_TEST_MODE__')) {
    const modelNeedle = "const MODEL =\n  'agnes-video-2.5-flash';\n\nconst LEGACY_MODEL =\n  'agnes-video-2.5-flash';";
    if (out.includes(modelNeedle)) {
      out = out.replace(modelNeedle, "// __CSP_AGNES_V2_TEST_MODE__\nconst __CSP_V2_MODEL__ = 'agnes-video-v2.0';\n\nconst MODEL =\n  __CSP_V2_MODEL__;\n\nconst LEGACY_MODEL =\n  __CSP_V2_MODEL__;");
    }
  }

  if (!out.includes('// __CSP_V2_DURATION_FIX__')) {
    const oldFrameLine = '  primaryBody.num_frames = getValidLegacyFrames(requestedFrames);';
    if (out.includes(oldFrameLine)) {
      const fix = "  // __CSP_V2_DURATION_FIX__\n  const __CSP_V2_TARGET_FRAMES_FIX__ = Number(requestedFrames) || 193;\n  const __CSP_V2_FRAMES_FIX__ = Math.max(9, Math.min(441, Math.round((__CSP_V2_TARGET_FRAMES_FIX__ - 1) / 8) * 8 + 1));\n  primaryBody.num_frames = __CSP_V2_FRAMES_FIX__;\n  primaryBody.frame_rate = FRAME_RATE;\n  console.log('[V2.0] frame normalization: requested=' + __CSP_V2_TARGET_FRAMES_FIX__ + ', sent=' + __CSP_V2_FRAMES_FIX__ + ', duration=' + (__CSP_V2_FRAMES_FIX__ / FRAME_RATE).toFixed(3) + 's');";
      out = out.replace(oldFrameLine, fix);
    }
  }

  if (!out.includes('// __CSP_V2_BODY_FIX__')) {
    const postMarker = '  const response =';
    const pos = out.indexOf(postMarker);
    if (pos !== -1) {
      const bodyFix = "  // __CSP_V2_BODY_FIX__\n  primaryBody.model = MODEL;\n  primaryBody.frame_rate = FRAME_RATE;\n  delete primaryBody.mode;\n  delete primaryBody.seconds;\n  delete primaryBody.size;\n  delete primaryBody.aspect_ratio;\n  delete primaryBody.n;\n  delete primaryBody.first_frame;\n  delete primaryBody.last_frame;\n  delete primaryBody.images;\n  if (firstFrame) primaryBody.image = firstFrame;\n  else if (images.length) primaryBody.image = images[0];\n\n";
      out = out.slice(0, pos) + bodyFix + out.slice(pos);
    }
  }

  out = out.replace('const rateLimitRetryDelays = [\n  120000\n];', 'const rateLimitRetryDelays = [];');

  return out;
}, 'server.js');

patchFile(indexPath, source => {
  let out = source;

  if (!out.includes('cinema-v13-safe-response')) {
    const needle = '        const data = await res.json();';
    if (out.includes(needle)) {
      const replacement = "        /* cinema-v13-safe-response */\n        const responseText = await res.text();\n        let data = null;\n        if (responseText.trim()) {\n          try { data = JSON.parse(responseText); }\n          catch (parseError) {\n            if (!res.ok) throw new Error('Serveur HTTP ' + res.status + ' : ' + responseText.slice(0, 800));\n            addLog('Réponse serveur non JSON — récupération du job…', 'warn');\n          }\n        }\n        if (!res.ok) {\n          if (data && data.error) throw new Error(data.error);\n          throw new Error('Erreur serveur HTTP ' + res.status);\n        }\n        if (!data || !data.id) {\n          const headerJobId = res.headers.get('X-Job-Id');\n          if (headerJobId) data = { id: headerJobId, status: 'queued' };\n        }\n        if (!data || !data.id) {\n          const latestRes = await fetch('/api/jobs/latest', { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } });\n          const latestText = await latestRes.text();\n          let latestData = null;\n          if (latestText.trim()) { try { latestData = JSON.parse(latestText); } catch (_) {} }\n          if (latestRes.ok && latestData && latestData.id) data = { id: latestData.id, status: latestData.status || 'queued' };\n        }\n        if (!data || !data.id) throw new Error('Le serveur a créé ou accepté la demande mais n’a renvoyé aucun identifiant de job.');";
      out = out.replace(needle, replacement);
    }
  }

  if (!out.includes('// __CSP_V2_CLIENT_FRAME_FIX__')) {
    const frameNeedle = '            frames: Math.round(secondsPerScene * FRAME_RATE)';
    if (out.includes(frameNeedle)) {
      out = out.replace(frameNeedle, "            // __CSP_V2_CLIENT_FRAME_FIX__\n            frames: Math.max(9, Math.min(441, Math.round((secondsPerScene * FRAME_RATE - 1) / 8) * 8 + 1))");
    }
  }

  if (!out.includes('cinema-v13-safe-poll')) {
    const needle = "        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId));\n        const job = await res.json();\n        if (!res.ok) throw new Error(job.error || 'Job introuvable');";
    if (out.includes(needle)) {
      const replacement = "        /* cinema-v13-safe-poll */\n        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId)+'?t='+Date.now(), { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' } });\n        const pollText = await res.text();\n        let job = null;\n        if (pollText.trim()) {\n          try { job = JSON.parse(pollText); }\n          catch (parseError) { if (!res.ok) throw new Error('Serveur HTTP ' + res.status + ' : ' + pollText.slice(0, 800)); addLog('Réponse de suivi non JSON — nouvelle tentative…', 'warn'); }\n        } else { addLog('Réponse vide du serveur — nouvelle tentative dans 1,5 s…', 'warn'); }\n        if (!res.ok) { if (job && job.error) throw new Error(job.error); throw new Error('Job HTTP ' + res.status); }\n        if (!job) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }";
      out = out.replace(needle, replacement);
    }
  }

  return out;
}, 'public/index.html');

await import('./server.js');
