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

  const responseNeedle = `    return res\n      .status(202)\n      .json({`;
  if (!out.includes('X-Job-Id')) {
    if (!out.includes(responseNeedle)) throw new Error('Réponse 202 de /api/jobs introuvable');
    out = out.replace(responseNeedle, `    res.setHeader('X-Job-Id', id);\n    res.setHeader('Cache-Control', 'no-store');\n\n${responseNeedle}`);
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

  return out;
}, 'public/index.html');

await import('./server.js');
