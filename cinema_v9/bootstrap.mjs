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

  // Keep the server-side job recovery used by the mobile client.
  if (!out.includes('// __CSP_LATEST_JOB_FALLBACK__')) {
    const marker = "app.get(\\n  '/api/jobs/:id'";
    if (out.includes(marker)) {
      const route = "\\n// __CSP_LATEST_JOB_FALLBACK__\\napp.get('/api/jobs/latest', requirePrivateAuth, (req, res) => {\\n  const latest = Object.values(jobs).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];\\n  if (!latest) return res.status(404).json({ ok: false, error: 'NO_JOB' });\\n  res.setHeader('Cache-Control', 'no-store');\\n  return res.json(safeJob(latest));\\n});\\n";
      out = out.replace(marker, route + '\\n' + marker);
    }
  }

  if (!out.includes('// __CSP_PROCESSJOBS_SAFE_LAUNCH__')) {
    const oldLaunch = "setImmediate(() => {\\n    processJobs().catch(error => {\\n        console.error('[WORKER LAUNCH ERROR]', error);\\n    });\\n});";
    const newLaunch = "// __CSP_PROCESSJOBS_SAFE_LAUNCH__\\n    setImmediate(() => {\\n      try {\\n        processJobs();\\n      } catch (error) {\\n        console.error('[WORKER LAUNCH ERROR]', error);\\n      }\\n    });";
    if (out.includes(oldLaunch)) out = out.replace(oldLaunch, newLaunch);
  }

  if (!out.includes("res.setHeader('X-Job-Id', id)")) {
    const responseNeedle = "    return res\\n      .status(202)\\n      .json({";
    if (out.includes(responseNeedle)) {
      out = out.replace(responseNeedle, "    res.setHeader('X-Job-Id', id);\\n    res.setHeader('Cache-Control', 'no-store');\\n\\n" + responseNeedle);
    }
  }

  // The actual polling delay is local to pollVideo. Keep the already-tested 5s interval.
  if (!out.includes('// __CSP_AGNES_POLL_5S__')) {
    const oldPoll = '  const pollDelay =\\n    20000;';
    const newPoll = "  // __CSP_AGNES_POLL_5S__\\n  const pollDelay =\\n    5000;";
    if (out.includes(oldPoll)) out = out.replace(oldPoll, newPoll);
  }

  // Keep timing logs; they do not change auth, downloads, UI or progress handling.
  if (!out.includes('// __CSP_AGNES_PHASE_TIMING__')) {
    const oldCreate = "        if (!scene.videoId) {\\n          const sceneInput = {";
    const newCreate = "        // __CSP_AGNES_PHASE_TIMING__\\n        const __CSP_SCENE_STARTED_AT__ = Date.now();\\n        if (!scene.videoId) {\\n          const __CSP_CREATE_STARTED_AT__ = Date.now();\\n          const sceneInput = {";
    if (out.includes(oldCreate)) out = out.replace(oldCreate, newCreate);

    const oldCreated = "          updateJob(job);\\n        }\\n\\n        scene.videoUrl =\\n          await pollVideo(";
    const newCreated = "          updateJob(job);\\n          console.log('[AGNES TIMING] create phase: ' + ((Date.now() - __CSP_CREATE_STARTED_AT__) / 1000).toFixed(1) + 's');\\n        } else {\\n          console.log('[AGNES TIMING] existing videoId reused; create phase skipped');\\n        }\\n\\n        const __CSP_POLL_STARTED_AT__ = Date.now();\\n        scene.videoUrl =\\n          await pollVideo(";
    if (out.includes(oldCreated)) out = out.replace(oldCreated, newCreated);

    const oldDone = "        scene.status =\\n          'done';";
    const newDone = "        console.log('[AGNES TIMING] poll phase: ' + ((Date.now() - __CSP_POLL_STARTED_AT__) / 1000).toFixed(1) + 's');\\n        console.log('[AGNES TIMING] total scene: ' + ((Date.now() - __CSP_SCENE_STARTED_AT__) / 1000).toFixed(1) + 's');\\n\\n        scene.status =\\n          'done';";
    if (out.includes(oldDone)) out = out.replace(oldDone, newDone);
  }

  // Do not add long rate-limit sleeps to the request path.
  out = out.replace('const rateLimitRetryDelays = [\\n  120000\\n];', 'const rateLimitRetryDelays = [];');

  return out;
}, 'server.js');

patchFile(indexPath, source => {
  let out = source;

  if (!out.includes('cinema-v13-safe-response')) {
    const needle = '        const data = await res.json();';
    if (out.includes(needle)) {
      const replacement = "        /* cinema-v13-safe-response */\n        const responseText = await res.text();\n        let data = null;\n        if (responseText.trim()) {\n          try { data = JSON.parse(responseText); }\n          catch (parseError) {\n            if (!res.ok) throw new Error('Serveur HTTP ' + res.status + ' : ' + responseText.slice(0, 800));\n            addLog('Réponse serveur non JSON — récupération du job…', 'warn');\n          }\n        }\n        if (!res.ok) {\n          if (data && data.error) throw new Error(data.error);\n          throw new Error('Erreur serveur HTTP ' + res.status);\n        }\n        if (!data || !data.id) {\n          const headerJobId = res.headers.get('X-Job-Id');\n          if (headerJobId) data = { id: headerJobId, status: 'queued' };\n        }\n        if (!data || !data.id) {\n          const latestRes = await fetch('/api/jobs/latest', { credentials: 'include', cache: 'no-store', headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' } });\n          const latestText = await latestRes.text();\n          let latestData = null;\n          if (latestText.trim()) { try { latestData = JSON.parse(latestText); } catch (_) {} }\n          if (latestRes.status === 401) throw new Error('Session serveur expirée — reconnecte-toi avant de relancer la génération.');\n          if (latestRes.ok && latestData && latestData.id) data = { id: latestData.id, status: latestData.status || 'queued' };\n        }\n        if (!data || !data.id) throw new Error('Le serveur a créé ou accepté la demande mais n’a renvoyé aucun identifiant de job.');";
      out = out.replace(needle, replacement);
    }
  }

  if (!out.includes('// __CSP_JOB_POST_RETRY__')) {
    const needle = "        const res = await fetch('/api/jobs', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body:JSON.stringify(payload) });";
    if (out.includes(needle)) {
      const replacement = "        // __CSP_JOB_POST_RETRY__\n        let res = null;\n        let lastNetworkError = null;\n        for (let attempt = 1; attempt <= 3; attempt++) {\n          try {\n            res = await fetch('/api/jobs', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', cache:'no-store', body:JSON.stringify(payload) });\n            break;\n          } catch (networkError) {\n            lastNetworkError = networkError;\n            addLog('Connexion au serveur échouée — nouvelle tentative ' + (attempt + 1) + '/3…', 'warn');\n            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2500 * attempt));\n          }\n        }\n        if (!res) throw lastNetworkError || new Error('Connexion au serveur impossible');\n        if (res.status === 401) {\n          throw new Error('Session serveur expirée — reconnecte-toi avant de relancer la génération.');\n        }";
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
      const replacement = "        /* cinema-v13-safe-poll */\n        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId)+'?t='+Date.now(), { method: 'GET', credentials: 'include', cache: 'no-store', headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' } });\n        const pollText = await res.text();\n        let job = null;\n        if (pollText.trim()) {\n          try { job = JSON.parse(pollText); }\n          catch (parseError) { if (!res.ok) throw new Error('Serveur HTTP ' + res.status + ' : ' + pollText.slice(0, 800)); addLog('Réponse de suivi non JSON — nouvelle tentative…', 'warn'); }\n        } else { addLog('Réponse vide du serveur — nouvelle tentative dans 1,5 s…', 'warn'); }\n        if (res.status === 401) throw new Error('Session serveur expirée pendant le suivi du job.');\n        if (!res.ok) { if (job && job.error) throw new Error(job.error); throw new Error('Job HTTP ' + res.status); }\n        if (!job) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }";
      out = out.replace(needle, replacement);
    }
  }

  return out;
}, 'public/index.html');

await import('./server.js');
