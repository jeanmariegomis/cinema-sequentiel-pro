import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.PORT || 10000;

// Agnes AI API
// AGNES_API_BASE may be either the API root or the /v1 root.
const AGNES_API_BASE = (process.env.AGNES_API_BASE || 'https://apihub.agnes-ai.com').replace(/\/+$/, '');
const API_ROOT = AGNES_API_BASE.endsWith('/v1')
  ? AGNES_API_BASE.slice(0, -3)
  : AGNES_API_BASE;
const CREATE_URL = AGNES_API_BASE.endsWith('/v1')
  ? `${AGNES_API_BASE}/videos`
  : `${AGNES_API_BASE}/v1/videos`;
const POLL_URL = `${API_ROOT}/agnesapi`;

const app = express();

// ===== V9.3 PRIVATE SERVER AUTH =====
function hashPassword(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
function timingSafeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (_) { return false; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
function makeAuthToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const payload = String(exp);
  const secret = process.env.AUTH_SECRET || '';
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function validAuthToken(token) {
  if (!token || !process.env.AUTH_SECRET) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(exp).digest('hex');
  return timingSafeEqualHex(sig, expected);
}
function requirePrivateAuth(req, res, next) {
  if (validAuthToken(getCookie(req, 'csp_auth'))) return next();
  return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
}

function setupPrivateAuthRoutes() {
  app.post('/api/auth/login', express.json(), (req, res) => {
    const password = String(req.body?.password ?? '');
    const plainPassword = process.env.APP_PASSWORD ?? '';
    const expectedHash = process.env.APP_PASSWORD_SHA256 ?? '';
    const authSecretConfigured = Boolean(process.env.AUTH_SECRET);

    // Debug sécurisé : aucun secret n'est affiché.
    console.log('===== AUTH DEBUG =====');
    console.log('Password received:', password.length > 0);
    console.log('Password length:', password.length);
    console.log('APP_PASSWORD configured:', plainPassword.length > 0);
    console.log('APP_PASSWORD length:', plainPassword.length);
    console.log('APP_PASSWORD_SHA256 configured:', expectedHash.length > 0);
    console.log('AUTH_SECRET configured:', authSecretConfigured);

    let valid = false;
    if (plainPassword !== '') {
      valid = timingSafeEqualHex(hashPassword(password), hashPassword(plainPassword));
      console.log('Authentication method: APP_PASSWORD');
    } else if (expectedHash !== '') {
      valid = timingSafeEqualHex(hashPassword(password), expectedHash.trim().toLowerCase());
      console.log('Authentication method: APP_PASSWORD_SHA256');
    } else {
      console.log('Authentication method: NONE');
    }

    console.log('Password comparison result:', valid);
    console.log('======================');

    if ((!plainPassword && !expectedHash) || !authSecretConfigured) {
      return res.status(503).json({ ok: false, error: 'AUTH_NOT_CONFIGURED' });
    }
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'INVALID_PASSWORD' });
    }

    const token = makeAuthToken();
    res.setHeader(
      'Set-Cookie',
      `csp_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`
    );
    console.log('Authentication successful');
    return res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'csp_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: validAuthToken(getCookie(req, 'csp_auth')) });
  });
}

// Per-user Agnes AI key, with server key as fallback.
function getAgnesKey(req) {
  const fromClient = req.get('X-Agnes-API-Key');
  return (fromClient && fromClient.trim()) || '';
}
const AGNES_API_KEY = process.env.AGNES_API_KEY || '';
function getApiKeyForRequest(req) {
  try {
    const k = getAgnesKey(req);
    if (k) return k;
  } catch {}
  return process.env.AGNES_API_KEY || AGNES_API_KEY || '';
}

const MODEL_VIDEO = 'agnes-video-v2.0';
const DEFAULT_FRAME_RATE = 22;
const MAX_FRAMES = 441;
const DATA_DIR = path.join(process.cwd(), 'data');
const INPUT_DIR = path.join(DATA_DIR, 'generated-inputs');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(INPUT_DIR, { recursive: true });

setupPrivateAuthRoutes();
app.use(express.json({ limit: '25mb' }));

// Public static files from the app.
app.use(express.static(path.join(process.cwd(), 'public')));

// Public reference images for Agnes image-to-video.
app.use('/generated-inputs', express.static(INPUT_DIR, {
  maxAge: '1h',
  index: false
}));

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}
let jobs = loadJobs();

function safeJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    total: job.scenes.length,
    completed: job.scenes.filter(s => s.status === 'done').length,
    failed: job.scenes.filter(s => s.status === 'failed').length,
    scenes: job.scenes.map((s, i) => ({
      index: i,
      status: s.status,
      videoUrl: s.videoUrl || null,
      error: s.error || null
    }))
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getPublicBaseUrl(req) {
  const external = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (external) return external;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${proto}://${host}` : '';
}

function saveDataImageToPublic(imageData, req) {
  if (typeof imageData !== 'string') return imageData || null;
  if (!imageData.startsWith('data:image/')) return imageData;

  const match = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!match) throw new Error('Image de référence base64 invalide.');

  const mime = match[1].toLowerCase();
  const extMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };
  const ext = extMap[mime] || 'png';
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(INPUT_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(match[2], 'base64'));

  const base = getPublicBaseUrl(req);
  if (!base) throw new Error('URL publique Render introuvable pour l\'image de référence.');
  return `${base}/generated-inputs/${encodeURIComponent(filename)}`;
}

function normalizeFrames(value) {
  const requested = Number(value);
  const safe = Number.isFinite(requested) && requested > 0 ? requested : MAX_FRAMES;
  const capped = Math.min(Math.floor(safe), MAX_FRAMES);
  // Agnes v2.0 requires 8n+1 frames.
  return Math.max(9, 1 + 8 * Math.floor((capped - 1) / 8));
}

function normalizeFrameRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FRAME_RATE;
  return Math.max(1, Math.min(60, n));
}

async function fetchText(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Délai réseau dépassé vers Agnes (${timeoutMs / 1000}s).`);
    throw new Error(`Connexion Agnes impossible: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonOrThrow(txt, label) {
  try { return JSON.parse(txt); }
  catch { throw new Error(`${label}: réponse JSON invalide — ${txt.slice(0, 400)}`); }
}

async function createVideoTask(scene, req) {
  const apiKeyToUse = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!apiKeyToUse) throw new Error('AGNES_API_KEY absente du serveur.');

  const frames = normalizeFrames(scene.frames);
  const frameRate = normalizeFrameRate(scene.frameRate);
  const body = {
    model: MODEL_VIDEO,
    prompt: String(scene.prompt || ''),
    num_frames: frames,
    frame_rate: frameRate
  };

  if (scene.image) body.image = saveDataImageToPublic(scene.image, req);

  console.log(`[AGNES] création: model=${MODEL_VIDEO}, frames=${frames}, fps=${frameRate}, image=${Boolean(body.image)}`);

  const res = await fetchText(CREATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKeyToUse}`
    },
    body: JSON.stringify(body)
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Création Agnes HTTP ${res.status} — ${txt.slice(0, 500)}`);
  const data = parseJsonOrThrow(txt, 'Création Agnes');
  const id = data.video_id || data.id || data.task_id;
  if (!id) throw new Error(`Agnes n'a pas retourné de video_id — ${txt.slice(0, 500)}`);
  return id;
}

async function pollVideo(videoId, req) {
  const apiKeyToUse = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!apiKeyToUse) throw new Error('AGNES_API_KEY absente du serveur.');

  for (let attempt = 0; attempt < 120; attempt++) {
    const url = `${POLL_URL}?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(MODEL_VIDEO)}`;
    const res = await fetchText(url, {
      headers: { 'Authorization': `Bearer ${apiKeyToUse}` }
    }, 90000);
    const txt = await res.text();

    if (!res.ok) throw new Error(`Polling Agnes HTTP ${res.status} — ${txt.slice(0, 400)}`);
    const d = parseJsonOrThrow(txt, 'Polling Agnes');
    const status = String(d.status || d.state || 'unknown').toLowerCase();

    if (['completed', 'succeeded', 'done'].includes(status)) {
      const urlOut = d.url || d.video_url || d.output?.url || d.metadata?.url;
      if (urlOut) return urlOut;

      // Some Agnes responses can return a remixed video id instead of a direct URL.
      if (d.remixed_from_video_id) return `${POLL_URL}?video_id=${encodeURIComponent(d.remixed_from_video_id)}&model_name=${encodeURIComponent(MODEL_VIDEO)}`;
      throw new Error(`Vidéo terminée mais URL absente — ${txt.slice(0, 500)}`);
    }

    if (['failed', 'error', 'cancelled'].includes(status)) {
      const detail = d.error?.message || d.error || d.message || status;
      throw new Error(`Échec moteur vidéo: ${String(detail).slice(0, 500)}`);
    }

    if (attempt === 0 || attempt % 5 === 0) {
      console.log(`[AGNES] polling ${videoId}: status=${status}, tentative=${attempt + 1}`);
    }
    await sleep(5000);
  }

  throw new Error('Délai maximal de génération dépassé.');
}

let workerBusy = false;
async function processJobs() {
  if (workerBusy) return;
  const apiKeyToUse = process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!apiKeyToUse) return;

  const job = Object.values(jobs).find(j => j.status === 'queued' || j.status === 'processing');
  if (!job) return;

  workerBusy = true;
  try {
    job.status = 'processing';
    job.updatedAt = Date.now();
    saveJobs(jobs);

    for (const scene of job.scenes) {
      if (scene.status === 'done') continue;
      if (job.status === 'cancelled') break;

      scene.status = 'processing';
      job.updatedAt = Date.now();
      saveJobs(jobs);

      try {
        // Server-side worker: the server key is used here.
        const workerReq = {
          get: () => '',
          protocol: 'https',
          get: (name) => {
            if (name === 'x-forwarded-proto') return 'https';
            if (name === 'x-forwarded-host') return process.env.RENDER_EXTERNAL_HOSTNAME || '';
            if (name === 'host') return process.env.RENDER_EXTERNAL_HOSTNAME || '';
            return '';
          },
          req: null
        };

        const videoId = await createVideoTask(scene, workerReq);
        scene.videoId = videoId;
        job.updatedAt = Date.now();
        saveJobs(jobs);

        scene.videoUrl = await pollVideo(videoId, workerReq);
        scene.status = 'done';
        scene.error = null;
      } catch (e) {
        scene.status = 'failed';
        scene.error = e?.message || String(e);
        job.status = 'failed';
        job.updatedAt = Date.now();
        saveJobs(jobs);
        console.error(`[JOB ${job.id}] scène échouée:`, scene.error);
        break;
      }

      job.updatedAt = Date.now();
      saveJobs(jobs);
    }

    if (job.scenes.every(s => s.status === 'done')) job.status = 'completed';
    else if (job.status !== 'failed' && job.status !== 'cancelled') job.status = 'queued';
    job.updatedAt = Date.now();
    saveJobs(jobs);
  } finally {
    workerBusy = false;
  }
}

app.get('/api/health', (req, res) => res.json({
  ok: true,
  workerConfigured: Boolean(process.env.AGNES_API_KEY || AGNES_API_KEY),
  model: MODEL_VIDEO,
  createEndpoint: CREATE_URL,
  pollEndpoint: POLL_URL,
  maxFrames: MAX_FRAMES,
  defaultFrameRate: DEFAULT_FRAME_RATE,
  renderExternalUrlConfigured: Boolean(process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME)
}));

app.post('/api/jobs', requirePrivateAuth, (req, res) => {
  const key = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!key) return res.status(503).json({ error: 'AGNES_API_KEY non configurée sur le serveur.' });

  const { scenes } = req.body || {};
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'Aucune scène.' });
  if (scenes.length > 20) return res.status(400).json({ error: 'Trop de scènes.' });

  const id = crypto.randomUUID();
  jobs[id] = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scenes: scenes.map(s => ({
      prompt: String(s.prompt || ''),
      image: s.image || null,
      frames: normalizeFrames(s.frames),
      frameRate: normalizeFrameRate(s.frameRate),
      status: 'pending',
      videoUrl: null,
      error: null
    }))
  };

  saveJobs(jobs);
  processJobs();
  res.status(202).json({ id, status: 'queued' });
});

app.get('/api/jobs/:id', requirePrivateAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  res.json(safeJob(job));
});

app.post('/api/jobs/:id/cancel', requirePrivateAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.status === 'completed') return res.status(409).json({ error: 'Déjà terminé' });
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  saveJobs(jobs);
  res.json(safeJob(job));
});

app.get(/.*/, (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));
app.listen(PORT, () => console.log(`Cinema V10 listening on :${PORT}`));
setInterval(processJobs, 3000);
processJobs();
