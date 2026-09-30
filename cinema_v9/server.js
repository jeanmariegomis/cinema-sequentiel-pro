import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.AGNES_API_BASE || 'https://apihub.agnes-ai.com/v1';
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
  res.setHeader('Cache-Control', 'no-store');
  const password = String(req.body?.password ?? '');

  const plainPassword = process.env.APP_PASSWORD ?? '';
  const expectedHash = process.env.APP_PASSWORD_SHA256 ?? '';
  const authSecretConfigured = Boolean(process.env.AUTH_SECRET);

  // ===== AUTH DEBUG — aucun mot de passe n'est affiché =====
  console.log('===== AUTH DEBUG =====');
  console.log('Password received:', password.length > 0);
  console.log('Password length:', password.length);
  console.log('APP_PASSWORD configured:', plainPassword.length > 0);
  console.log('APP_PASSWORD length:', plainPassword.length);
  console.log('APP_PASSWORD_SHA256 configured:', expectedHash.length > 0);
  console.log('APP_PASSWORD_SHA256 length:', expectedHash.length);
  console.log('AUTH_SECRET configured:', authSecretConfigured);

  let valid = false;

  if (plainPassword !== '') {
    valid = timingSafeEqualHex(
      hashPassword(password),
      hashPassword(plainPassword)
    );

    console.log('Authentication method: APP_PASSWORD');
  } else if (expectedHash !== '') {
    valid = timingSafeEqualHex(
      hashPassword(password),
      expectedHash.trim().toLowerCase()
    );

    console.log('Authentication method: APP_PASSWORD_SHA256');
  } else {
    console.log('Authentication method: NONE');
  }

  console.log('Password comparison result:', valid);
  console.log('======================');

  if ((!plainPassword && !expectedHash) || !authSecretConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'AUTH_NOT_CONFIGURED'
    });
  }

  if (!valid) {
    return res.status(401).json({
      ok: false,
      error: 'INVALID_PASSWORD'
    });
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
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authenticated: validAuthToken(getCookie(req, 'csp_auth')) });
  });
}

// Per-user Agnes AI key
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

const MODEL = 'agnes-video-2.5-flash';
const FRAME_RATE = 24;
const DATA_DIR = path.join(process.cwd(), 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '25mb' }));

// ===== PRIVATE WEB GATE =====
// IMPORTANT: static files and the application itself are protected.
// Only the login page and authentication endpoints are public.
app.get('/login.html', (req, res) => {
  if (validAuthToken(getCookie(req, 'csp_auth'))) {
    return res.redirect('/');
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
});

setupPrivateAuthRoutes();

// Do NOT expose /public/index.html before authentication.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth/')) return next();
  if (validAuthToken(getCookie(req, 'csp_auth'))) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok:false, error:'AUTH_REQUIRED' });
  }
  return res.redirect('/login.html');
});

// Static files are available only after the authentication gate above.
app.use(express.static(path.join(process.cwd(), 'public')));

function loadJobs(){ try { return JSON.parse(fs.readFileSync(JOBS_FILE,'utf8')); } catch { return {}; } }
function saveJobs(jobs){ fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); }
let jobs = loadJobs();
function safeJob(job){
  return {
    id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    total: job.scenes.length, completed: job.scenes.filter(s=>s.status==='done').length,
    failed: job.scenes.filter(s=>s.status==='failed').length,
    scenes: job.scenes.map((s,i)=>({index:i,status:s.status,videoUrl:s.videoUrl||null,error:s.error||null}))
  };
}
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function createVideoTask(scene, req) {
  const apiKeyToUse =
    getApiKeyForRequest(req) ||
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  if (!apiKeyToUse) {
    throw new Error('AGNES_API_KEY non configurée');
  }

  const prompt = String(scene.prompt || '').trim();

  if (!prompt) {
    throw new Error('Prompt vidéo vide');
  }

  // Agnes Video 2.5 Flash accepte uniquement 4–12 s et 720P.
  const rawSeconds = Number(scene.seconds ?? (Number(scene.frames) ? Number(scene.frames) / FRAME_RATE : 8));
  const seconds = Math.max(4, Math.min(12, Math.round(rawSeconds)));
  const firstFrame = scene.first_frame || null;
  const lastFrame = scene.last_frame || null;
  const images = Array.isArray(scene.images) ? scene.images.filter(Boolean).slice(0, 5) : [];
  let mode = String(scene.mode || '').trim().toLowerCase();
  if (!['text', 'keyframe', 'reference'].includes(mode)) mode = '';
  if (!mode) {
    mode = (firstFrame || lastFrame) ? 'keyframe' : (images.length ? 'reference' : 'text');
  }

  const body = {
    model: MODEL,
    prompt,
    mode,
    seconds: String(seconds),
    size: '720P',
    aspect_ratio: scene.aspect_ratio || '9:16',
    n: 1
  };

  if (mode === 'keyframe') {
    if (firstFrame) body.first_frame = firstFrame;
    if (lastFrame) body.last_frame = lastFrame;
    if (!body.first_frame && !body.last_frame) {
      throw new Error('Mode keyframe sélectionné sans image de départ ou de fin');
    }
  }

  if (mode === 'reference') {
    if (!images.length) throw new Error('Mode reference sélectionné sans image de référence');
    body.images = images;
  }

  console.log(
    '[VIDEO CREATE]',
    JSON.stringify({
      model: body.model,
      mode: body.mode,
      seconds: body.seconds,
      size: body.size,
      aspect_ratio: body.aspect_ratio,
      hasFirstFrame: Boolean(body.first_frame),
      hasLastFrame: Boolean(body.last_frame),
      imageCount: Array.isArray(body.images) ? body.images.length : 0
    })
  );

  const response = await fetch(`${API_BASE}/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKeyToUse}`
    },
    body: JSON.stringify(body)
  });

  const txt = await response.text();

  if (!response.ok) {
    throw new Error(
      `Creation vidéo HTTP ${response.status}: ${txt.slice(0, 1000)}`
    );
  }

  let data;

  try {
    data = JSON.parse(txt);
  } catch {
    throw new Error(
      `Réponse Agnes invalide: ${txt.slice(0, 1000)}`
    );
  }

  const videoId =
    data.video_id ||
    data.id;

  if (!videoId) {
    throw new Error(
      `Agnes n'a pas retourné de video_id: ${JSON.stringify(data).slice(0, 1000)}`
    );
  }

  console.log('[VIDEO CREATED]', videoId);

  return videoId;
}


async function pollVideo(videoId, req) {
  const apiKeyToUse =
    getApiKeyForRequest(req) ||
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  if (!apiKeyToUse) {
    throw new Error('AGNES_API_KEY non configurée');
  }

  const maxAttempts = 180;
  const pollDelay = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url =
      `${API_BASE.replace(/\/v1\/?$/, '')}` +
      `/agnesapi?video_id=${encodeURIComponent(videoId)}` +
      `&model_name=${encodeURIComponent(MODEL)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKeyToUse}`
      }
    });

    const txt = await response.text();

    if (!response.ok) {
      throw new Error(
        `Polling HTTP ${response.status}: ${txt.slice(0, 1000)}`
      );
    }

    let data;

    try {
      data = JSON.parse(txt);
    } catch {
      throw new Error(
        `Réponse polling Agnes invalide: ${txt.slice(0, 1000)}`
      );
    }

    const status = String(data.status || '').toLowerCase();

    console.log(
      `[VIDEO POLL] ${videoId} → ${status || 'unknown'} ` +
      `${data.progress != null ? data.progress + '%' : ''}`
    );

    if (
      ['completed', 'succeeded', 'success', 'done'].includes(status)
    ) {
      const url =
        data.url ||
        data.video_url ||
        data.output?.url ||
        data.output?.video_url ||
        data.data?.url ||
        data.metadata?.url;

      if (!url) {
        throw new Error(
          `Vidéo terminée mais URL absente: ${JSON.stringify(data).slice(0, 1500)}`
        );
      }

      return url;
    }

    if (
      ['failed', 'error', 'cancelled', 'canceled'].includes(status)
    ) {
      const errorMessage =
        data.error?.message ||
        data.error ||
        data.message ||
        status;

      throw new Error(
        `Échec moteur vidéo: ${errorMessage}`
      );
    }

    await sleep(pollDelay);
  }

  throw new Error(
    `Délai maximal dépassé pour video_id=${videoId}`
  );
      
}

let workerBusy = false;
async function processJobs(){
  if(workerBusy) return;
  const apiKeyToUse = process.env.AGNES_API_KEY || AGNES_API_KEY;
  if(!apiKeyToUse) return;
  const job = Object.values(jobs).find(j => j.status === 'queued' || j.status === 'processing');
  if(!job) return;
  workerBusy = true;
  try{
    job.status='processing'; job.updatedAt=Date.now(); saveJobs(jobs);
    for(const scene of job.scenes){
      if(scene.status==='done') continue;
      scene.status='processing'; job.updatedAt=Date.now(); saveJobs(jobs);
      try{
        const videoId = await createVideoTask(scene, { get:()=>'' });
        scene.videoId = videoId; job.updatedAt=Date.now(); saveJobs(jobs);
        scene.videoUrl = await pollVideo(videoId, { get:()=>'' });
        scene.status='done'; scene.error=null;
      }catch(e){
        scene.status='failed'; scene.error=e.message;
        job.status='failed'; job.updatedAt=Date.now(); saveJobs(jobs);
        break;
      }
      job.updatedAt=Date.now(); saveJobs(jobs);
    }
    if(job.scenes.every(s=>s.status==='done')) job.status='completed';
    else if(job.status!=='failed') job.status='queued';
    job.updatedAt=Date.now(); saveJobs(jobs);
  } finally { workerBusy=false; }
}

app.get('/api/health',(req,res)=>res.json({ok:true,workerConfigured:Boolean(process.env.AGNES_API_KEY || AGNES_API_KEY)}));

app.post('/api/jobs',requirePrivateAuth, (req,res)=>{
  const key = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  if(!key) return res.status(503).json({error:'AGNES_API_KEY non configurée sur le serveur.'});
  const {scenes}=req.body||{};
  if(!Array.isArray(scenes)||!scenes.length) return res.status(400).json({error:'Aucune scène.'});
  if(scenes.length>20) return res.status(400).json({error:'Trop de scènes.'});
  const id=crypto.randomUUID();
  jobs[id] = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scenes: scenes.map(s => {
      const legacyImage = s.image || null;
      const images = Array.isArray(s.images) && s.images.length ? s.images.slice(0, 5) : (legacyImage ? [legacyImage] : []);
      return {
        prompt: String(s.prompt || ''),
        mode: s.mode || (images.length ? 'reference' : 'text'),
        seconds: Number(s.seconds) || (Number(s.frames) ? Number(s.frames) / FRAME_RATE : 8),
        size: '720P',
        aspect_ratio: s.aspect_ratio || '9:16',
        first_frame: s.first_frame || null,
        last_frame: s.last_frame || null,
        images,
        frames: Number(s.frames) || 192,
        status: 'pending',
        videoUrl: null,
        error: null
      };
    })
  };
  saveJobs(jobs); processJobs();
  res.status(202).json({id,status:'queued'});
});

app.get('/api/jobs/:id',requirePrivateAuth, (req,res)=>{
  const job=jobs[req.params.id];
  if(!job) return res.status(404).json({error:'Job introuvable'});
  res.json(safeJob(job));
});

app.post('/api/jobs/:id/cancel',requirePrivateAuth, (req,res)=>{
  const job=jobs[req.params.id];
  if(!job) return res.status(404).json({error:'Job introuvable'});
  if(job.status==='completed') return res.status(409).json({error:'Déjà terminé'});
  job.status='cancelled'; job.updatedAt=Date.now(); saveJobs(jobs); res.json(safeJob(job));
});

app.get('/', (req,res)=>res.sendFile(path.join(process.cwd(),'public','index.html')));
app.get(/^(?!\/api\/).*/, (req,res)=>res.sendFile(path.join(process.cwd(),'public','index.html')));
app.listen(PORT,()=>console.log(`Cinema V9 listening on :${PORT}`));
setInterval(processJobs,3000);
processJobs();
