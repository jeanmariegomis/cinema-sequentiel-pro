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

  if (!out.includes('// __CSP_LATEST_JOB_FALLBACK__')) {
    const route = `
// __CSP_LATEST_JOB_FALLBACK__
app.get(
  '/api/jobs/latest',
  requirePrivateAuth,
  (req, res) => {
    const latest = Object.values(jobs)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];

    if (!latest) {
      return res.status(404).json({ ok: false, error: 'NO_JOB' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json(safeJob(latest));
  }
);
`;
    const marker = "app.get(\n  '/api/jobs/:id'";
    if (!out.includes(marker)) throw new Error('Route /api/jobs/:id introuvable pour insertion du fallback');
    out = out.replace(marker, route + '\n' + marker);
  }

  if (!out.includes('// __CSP_PROCESSJOBS_SAFE_LAUNCH__')) {
    const workerLaunchPattern = /setImmediate\(\(\) => \{\s*processJobs\(\)\.catch\(error => \{\s*console\.error\('\[WORKER LAUNCH ERROR\]', error\);\s*\}\);\s*\}\);/;
    if (!workerLaunchPattern.test(out)) {
      throw new Error('Lancement processJobs() introuvable pour correction du worker');
    }
    const safeLaunch = `// __CSP_PROCESSJOBS_SAFE_LAUNCH__
    setImmediate(() => {
      try {
        processJobs();
      } catch (error) {
        console.error('[WORKER LAUNCH ERROR]', error);
      }
    });`;
    out = out.replace(workerLaunchPattern, safeLaunch);
  }

  const responseNeedle = `    return res\n      .status(202)\n      .json({`;
  if (!out.includes('X-Job-Id')) {
    if (!out.includes(responseNeedle)) throw new Error('Réponse 202 de /api/jobs introuvable');
    out = out.replace(responseNeedle, `    res.setHeader('X-Job-Id', id);\n    res.setHeader('Cache-Control', 'no-store');\n\n${responseNeedle}`);
  }

  // __CSP_AGNES_V2_TEST_MODE__
  // Force the video path to use the legacy Agnes Video V2.0 API schema.
  if (!out.includes('// __CSP_AGNES_V2_TEST_MODE__')) {
    const modelPatch = `// __CSP_AGNES_V2_TEST_MODE__\n\nconst __CSP_V2_MODEL__ = 'agnes-video-v2.0';\n\n`;
    const modelNeedle = "const MODEL =\n  'agnes-video-2.5-flash';\n\nconst LEGACY_MODEL =\n  'agnes-video-2.5-flash';";
    if (!out.includes(modelNeedle)) throw new Error('Configuration Agnes Video 2.5 introuvable pour activation V2.0');
    out = out.replace(
      modelNeedle,
      `${modelPatch}const MODEL =\n  __CSP_V2_MODEL__;\n\nconst LEGACY_MODEL =\n  __CSP_V2_MODEL__;`
    );

    const bodyNeedle = `  // ==========================================================\n  // POST HELPER\n  // ==========================================================`;
    if (!out.includes(bodyNeedle)) throw new Error('Bloc POST helper introuvable pour activation V2.0');

    const v2BodyPatch = `  // __CSP_AGNES_V2_BODY__\n  // V2.0 accepts prompt + image + num_frames + frame_rate.\n  // Convert the UI duration-derived frame count to the mandatory 8n+1 sequence.\n  const __CSP_V2_TARGET_FRAMES__ = Number(requestedFrames) || 121;\n  const __CSP_V2_FRAMES__ = Math.max(9, Math.min(441, Math.round((__CSP_V2_TARGET_FRAMES__ - 1) / 8) * 8 + 1));\n  const __CSP_V2_SECONDS__ = __CSP_V2_FRAMES__ / FRAME_RATE;\n\n  primaryBody.model = MODEL;\n  primaryBody.num_frames = __CSP_V2_FRAMES__;\n  primaryBody.frame_rate = FRAME_RATE;\n  delete primaryBody.mode;\n  delete primaryBody.seconds;\n  delete primaryBody.size;\n  delete primaryBody.aspect_ratio;\n  delete primaryBody.n;\n  delete primaryBody.first_frame;\n  delete primaryBody.last_frame;\n  delete primaryBody.images;\n\n  if (firstFrame) {\n    primaryBody.image = firstFrame;\n  } else if (images.length) {\n    primaryBody.image = images[0];\n  }\n\n  console.log(`[V2.0] durée demandée=${(__CSP_V2_TARGET_FRAMES__ / FRAME_RATE).toFixed(2)}s | frames=${__CSP_V2_FRAMES__} | fps=${FRAME_RATE} | durée réelle théorique=${__CSP_V2_SECONDS__.toFixed(3)}s`);\n\n`;
    out = out.replace(bodyNeedle, v2BodyPatch + bodyNeedle);

    out = out.replace(
      "const rateLimitRetryDelays = [\n  120000\n];",
      "const rateLimitRetryDelays = [];"
    );

    console.log('[BOOTSTRAP] Agnes Video V2.0 test mode enabled');
  }

  // __CSP_V2_DURATION_FIX__
  // Fix already-deployed V2.0 servers that still convert 8s to 192 frames.
  // Agnes V2.0 requires 8n+1 frames; 193 frames at 24fps gives ~8.04s.
  if (!out.includes('// __CSP_V2_DURATION_FIX__')) {
    const oldFrameLine = '  primaryBody.num_frames = getValidLegacyFrames(requestedFrames);';
    if (out.includes(oldFrameLine)) {
      const durationFix = `  // __CSP_V2_DURATION_FIX__\n  const __CSP_V2_TARGET_FRAMES_FIX__ = Number(requestedFrames) || 121;\n  const __CSP_V2_FRAMES_FIX__ = Math.max(9, Math.min(441, Math.round((__CSP_V2_TARGET_FRAMES_FIX__ - 1) / 8) * 8 + 1));\n  primaryBody.num_frames = __CSP_V2_FRAMES_FIX__;\n  primaryBody.frame_rate = FRAME_RATE;\n  console.log('[V2.0] frame normalization: requested=' + __CSP_V2_TARGET_FRAMES_FIX__ + ', sent=' + __CSP_V2_FRAMES_FIX__ + ', duration=' + (__CSP_V2_FRAMES_FIX__ / FRAME_RATE).toFixed(3) + 's');`;
      out = out.replace(oldFrameLine, durationFix);
    }
  }

  return out;
}, 'server.js');

patchFile(indexPath, source => {
  let out = source;

  const createNeedle = '        const data = await res.json();';
  if (!out.includes('cinema-v13-safe-response')) {
    if (!out.includes(createNeedle)) throw new Error('Lecture res.json() de /api/jobs introuvable');
    const replacement = `        /* cinema-v13-safe-response: never assume a non-empty JSON body */
        const responseText = await res.text();
        let data = null;

        if (responseText.trim()) {
            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                if (!res.ok) {
                    throw new Error('Serveur HTTP ' + res.status + ' : ' + responseText.slice(0, 800));
                }
                addLog('Réponse serveur non JSON reçue, tentative de récupération du job…', 'warn');
            }
        }

        if (!res.ok) {
            if (data && data.error) throw new Error(data.error);
            throw new Error('Erreur serveur HTTP ' + res.status);
        }

        if (!data || !data.id) {
            const headerJobId = res.headers.get('X-Job-Id');
            if (headerJobId) {
                data = { id: headerJobId, status: 'queued' };
                addLog('☁️ Job récupéré depuis X-Job-Id : ' + headerJobId, 'success');
            }
        }

        if (!data || !data.id) {
            const latestRes = await fetch('/api/jobs/latest', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            });
            const latestText = await latestRes.text();
            let latestData = null;
            if (latestText.trim()) {
                try { latestData = JSON.parse(latestText); } catch (_) {}
            }
            if (latestRes.ok && latestData && latestData.id) {
                data = { id: latestData.id, status: latestData.status || 'queued' };
                addLog('☁️ Job récupéré via /api/jobs/latest : ' + latestData.id, 'success');
            }
        }

        if (!data || !data.id) {
            throw new Error('Le serveur a créé ou accepté la demande mais n’a renvoyé aucun identifiant de job.');
        }`;
    out = out.replace(createNeedle, replacement);
  }

  const pollNeedle = `        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId));\n        const job = await res.json();\n        if (!res.ok) throw new Error(job.error || 'Job introuvable');`;
  if (!out.includes('cinema-v13-safe-poll')) {
    if (!out.includes(pollNeedle)) throw new Error('Lecture res.json() du polling /api/jobs/:id introuvable');
    const pollReplacement = `        /* cinema-v13-safe-poll: tolerate empty/transient proxy responses */
        const res = await fetch('/api/jobs/'+encodeURIComponent(jobId)+'?t='+Date.now(), {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
        });
        const pollText = await res.text();
        let job = null;

        if (pollText.trim()) {
            try {
                job = JSON.parse(pollText);
            } catch (parseError) {
                if (!res.ok) {
                    throw new Error('Serveur HTTP ' + res.status + ' : ' + pollText.slice(0, 800));
                }
                addLog('Réponse de suivi non JSON — nouvelle tentative…', 'warn');
            }
        } else {
            addLog('Réponse vide du serveur — nouvelle tentative dans 1,5 s…', 'warn');
        }

        if (!res.ok) {
            if (job && job.error) throw new Error(job.error);
            throw new Error('Job HTTP ' + res.status);
        }

        if (!job) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            continue;
        }`;
    out = out.replace(pollNeedle, pollReplacement);
  }

  // __CSP_V2_DURATION_LOG__
  // Keep compatibility with the existing diagnostic patch.
  if (!out.includes('__CSP_V2_DURATION_LOG__')) {
    const logPatch = `
<script>
// __CSP_V2_DURATION_LOG__
(() => {
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    try {
      if (args.length === 1 && typeof args[0] === 'string') {
        args[0] = args[0].replace(/(Durée\/scène\s*:\s*)192(\s+frames\s+\()8\.0(s\))/i, '$1' + '193' + '$2' + '8.04' + '$3');
      }
    } catch (_) {}
    return originalConsoleLog.apply(this, args);
  };
})();
</script>
`;
    out = out.replace('</body>', logPatch + '\n</body>');
  }

  // __CSP_V2_DURATION_LOG_GENERIC__
  // Normalize any old UI diagnostic frame count to a valid V2.0 8n+1 count.
  if (!out.includes('__CSP_V2_DURATION_LOG_GENERIC__')) {
    const genericLogPatch = `
<script>
// __CSP_V2_DURATION_LOG_GENERIC__
(() => {
  const previousConsoleLog = console.log;
  console.log = function(...args) {
    try {
      if (args.length === 1 && typeof args[0] === 'string') {
        args[0] = args[0].replace(/(Durée\/scène\\s*:\\s*)(\\d+)(\\s+frames\\s+\\()([\\d.]+)(s\\))/i, (full, prefix, rawFrames, middle, rawSeconds, suffix) => {
          const requested = Number(rawFrames);
          if (!Number.isFinite(requested) || requested < 1) return full;
          const normalized = Math.max(9, Math.min(441, Math.round((requested - 1) / 8) * 8 + 1));
          const seconds = normalized / 24;
          return prefix + normalized + middle + seconds.toFixed(2) + suffix;
        });
      }
    } catch (_) {}
    return previousConsoleLog.apply(this, args);
  };
})();
</script>
`;
    out = out.replace('</body>', genericLogPatch + '\n</body>');
  }

  return out;
}, 'public/index.html');

await import('./server.js');
