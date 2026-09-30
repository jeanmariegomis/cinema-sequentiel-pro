import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

// ================================================================
// CINEMA SEQUENTIEL PRO — SERVER V11
// - Auth APP_PASSWORD + AUTH_SECRET preserved
// - Correct Agnes V2.0 endpoints
// - Public hosting for reference images (Agnes needs public URLs)
// - Sequential continuity: scene N+1 starts from last frame of N
// - FFmpeg server-side frame extraction
// - Valid Agnes frame counts (8n+1, <=441)
// - 20s target supported with 441 frames @ 22fps (~20.05s)
// - French/no-text continuity constraints
// ================================================================

const PORT = Number(process.env.PORT || 10000);
const API_BASE = (process.env.AGNES_API_BASE || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, '');
const POLL_BASE = (process.env.AGNES_POLL_BASE || 'https://apihub.agnes-ai.com/agnesapi').replace(/\/$/, '');
const MODEL_VIDEO = 'agnes-video-v2.0';
const DEFAULT_FRAME_RATE = Number(process.env.VIDEO_FRAME_RATE || 22);
const MAX_FRAMES = 441;
const app = express();

// ========================= AUTH =========================
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
  const [exp, sig] = String(token).split('.');
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

    // No secret values are logged.
    console.log('===== AUTH DEBUG V11 =====');
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
    console.log('==========================');

    if ((!plainPassword && !expectedHash) || !authSecretConfigured) {
      return res.status(503).json({ ok: false, error: 'AUTH_NOT_CONFIGURED' });
    }
    if (!valid) return res.status(401).json({ ok: false, error: 'INVALID_PASSWORD' });

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

// ========================= AGNES KEY =========================
const AGNES_API_KEY = process.env.AGNES_API_KEY || '';
function getAgnesKey(req) {
  try {
    const fromClient = req.get('X-Agnes-API-Key');
    return (fromClient && fromClient.trim()) || '';
  } catch (_) { return ''; }
}
function getApiKeyForRequest(req) {
  return getAgnesKey(req) || process.env.AGNES_API_KEY || AGNES_API_KEY || '';
}

// ========================= STORAGE =========================
const DATA_DIR = path.join(process.cwd(), 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

setupPrivateAuthRoutes();
app.use(express.json({ limit: '25mb' }));

// ===== WEB APP AUTH GATE =====
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const LOGIN_FILE = path.join(PUBLIC_DIR, 'login.html');

app.get(['/', '/index.html'], (req, res) => {
  if (validAuthToken(getCookie(req, 'csp_auth'))) return res.sendFile(INDEX_FILE);
  return res.sendFile(LOGIN_FILE);
});

app.use(express.static(PUBLIC_DIR));

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveJobs(value) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(value, null, 2));
}
let jobs = loadJobs();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Agnes V2.0 requires num_frames = 8n+1 and <= 441.
function normalizeFrames(requested, requestedFps = DEFAULT_FRAME_RATE) {
  const fps = clampInt(requestedFps, 1, 60, DEFAULT_FRAME_RATE);
  let frames = clampInt(requested, 121, MAX_FRAMES, 121);
  frames = 8 * Math.floor((frames - 1) / 8) + 1;
  frames = Math.max(9, Math.min(MAX_FRAMES, frames));
  return { frames, fps, seconds: frames / fps };
}

function getPublicBase(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const renderUrl = String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
  if (renderUrl) return renderUrl;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('host') || '').trim();
  if (!host) throw new Error('PUBLIC_BASE_URL introuvable. Configure PUBLIC_BASE_URL sur Render.');
  return `${proto}://${host}`;
}

function safeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseImageInput(image) {
  if (!image) return null;
  const value = String(image).trim();
  if (/^https?:\/\//i.test(value)) return { type: 'url', value };
  const match = value.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  const ext = match[1].toLowerCase() === 'jpg' ? 'jpg' : match[1].toLowerCase();
  return { type: 'data', ext, base64: match[2].replace(/\s+/g, '') };
}

function writeReferenceAsset(jobId, sceneIndex, imageInput) {
  const parsed = parseImageInput(imageInput);
  if (!parsed) return null;
  if (parsed.type === 'url') return parsed.value;

  const dir = path.join(ASSET_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const token = safeToken();
  const filename = `${sceneIndex}-${token}.${parsed.ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, Buffer.from(parsed.base64, 'base64'));
  return { filePath, token, ext: parsed.ext };
}

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
      error: s.error || null,
      referenceUsed: s.referenceSource === 'last-frame-of-previous-scene' ? 'last-frame' : (s.imageUrl ? 'initial-reference' : 'text-only')
    }))
  };
}

// Public, tokenized image endpoint used only by Agnes.
// The token is unguessable and the endpoint does not expose job JSON or keys.
app.get('/api/assets/:jobId/:token', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).end();
  const asset = (job.assets || {})[req.params.token];
  if (!asset || !asset.filePath || !fs.existsSync(asset.filePath)) return res.status(404).end();
  const ext = asset.ext === 'png' ? 'image/png' : asset.ext === 'webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type(ext).sendFile(path.resolve(asset.filePath));
});

function registerAsset(job, filePath, ext, publicBase) {
  const token = safeToken();
  job.assets = job.assets || {};
  job.assets[token] = { filePath, ext };
  return `${publicBase}/api/assets/${encodeURIComponent(job.id)}/${token}`;
}

const execFileAsync = promisify(execFile);

async function extractLastFrameToFile(videoUrl, jobId, sceneIndex) {
  const id = crypto.randomUUID();
  const inputPath = path.join(TMP_DIR, `${id}.mp4`);
  const outputPath = path.join(TMP_DIR, `${id}.jpg`);

  try {
    console.log(`[V11] Scene ${sceneIndex + 1}: download video for last-frame extraction`);
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error(`Téléchargement vidéo HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Vidéo vide reçue du moteur Agnes');
    fs.writeFileSync(inputPath, buffer);

    const common = ['-y', '-sseof', '-0.30', '-i', inputPath, '-frames:v', '1', '-q:v', '2', '-vf', 'scale=768:-2', outputPath];
    try {
      await execFileAsync(ffmpegPath.path, common, { timeout: 120000 });
    } catch (_) {
      await execFileAsync(ffmpegPath.path, ['-y', '-sseof', '-1', '-i', inputPath, '-frames:v', '1', '-q:v', '2', '-vf', 'scale=768:-2', outputPath], { timeout: 120000 });
    }

    if (!fs.existsSync(outputPath)) throw new Error('FFmpeg n’a pas produit la dernière image');
    const finalDir = path.join(ASSET_DIR, jobId);
    fs.mkdirSync(finalDir, { recursive: true });
    const finalPath = path.join(finalDir, `last-frame-${sceneIndex + 1}-${crypto.randomBytes(8).toString('hex')}.jpg`);
    fs.copyFileSync(outputPath, finalPath);
    return finalPath;
  } finally {
    try { fs.unlinkSync(inputPath); } catch (_) {}
    try { fs.unlinkSync(outputPath); } catch (_) {}
  }
}

function addContinuityToPrompt(prompt, sceneIndex) {
  const language = 'All spoken dialogue must be in French only. Do not speak English, Arabic, Spanish, Portuguese, German, or any other language.';
  const noText = 'No subtitles, no captions, no written words, no signs with readable text, no logos, no watermark, no UI text.';
  const identity = 'Preserve the exact same character identity: same face, eyes, eyebrows, nose, mouth, hairstyle, hair color, age, skin tone, body proportions, clothing, accessories and silhouette. Never redesign or replace the character.';
  const continuity = sceneIndex === 0
    ? 'This is the first scene. Establish the character and world exactly from the supplied reference image.'
    : 'This scene is a direct continuation of the immediately previous scene. Start from the supplied last-frame image as the exact visual starting state. Do not reset the story or redesign the character.';
  return `${String(prompt || '').trim()}\n\nABSOLUTE V11 CONTINUITY RULES:\n- ${identity}\n- ${continuity}\n- Keep environment, props, lighting direction, color palette and wardrobe consistent unless the prompt explicitly changes them.\n- Natural anatomy, hands, fingers, eyes and object scale.\n- ${language}\n- ${noText}`.trim();
}

const NEGATIVE_PROMPT = [
  'different face', 'different person', 'identity change', 'face redesign', 'age change',
  'different hairstyle', 'different hair color', 'different clothes', 'different body proportions',
  'deformed face', 'extra fingers', 'bad hands', 'extra limbs', 'duplicate person',
  'subtitles', 'captions', 'written text', 'letters', 'logos', 'watermark', 'UI',
  'English speech', 'Arabic speech', 'Spanish speech', 'Portuguese speech', 'German speech',
  'foreign language', 'unintelligible dialogue'
].join(', ');

async function createVideoTask(scene, req) {
  const apiKey = getApiKeyForRequest(req);
  if (!apiKey) throw new Error('AGNES_API_KEY non configurée sur le serveur.');

  const normalized = normalizeFrames(scene.frames, scene.frameRate || DEFAULT_FRAME_RATE);
  scene.frames = normalized.frames;
  scene.frameRate = normalized.fps;

  const body = {
    model: MODEL_VIDEO,
    prompt: addContinuityToPrompt(scene.prompt, scene.index),
    negative_prompt: NEGATIVE_PROMPT,
    width: 1152,
    height: 768,
    num_frames: normalized.frames,
    frame_rate: normalized.fps
  };

  if (scene.imageUrl) body.image = scene.imageUrl;

  console.log(`[V11] Creating scene ${scene.index + 1}: ${normalized.frames} frames @ ${normalized.fps}fps (${normalized.seconds.toFixed(2)}s), image=${Boolean(scene.imageUrl)}`);

  const res = await fetch(`${API_BASE}/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Creation HTTP ${res.status} — ${txt.slice(0, 500)}`);

  let data;
  try { data = JSON.parse(txt); }
  catch (_) { throw new Error('Réponse Agnes invalide lors de la création.'); }

  const id = data.video_id || data.id || data.task_id;
  if (!id) throw new Error("L'API Agnes n'a pas retourné de video_id/task_id.");
  return id;
}

async function pollVideo(videoId, req) {
  const apiKey = getApiKeyForRequest(req);
  if (!apiKey) throw new Error('AGNES_API_KEY non configurée sur le serveur.');

  for (let attempt = 0; attempt < 180; attempt++) {
    const url = `${POLL_BASE}?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(MODEL_VIDEO)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Polling HTTP ${res.status} — ${txt.slice(0, 400)}`);

    let d;
    try { d = JSON.parse(txt); }
    catch (_) { throw new Error('Réponse Agnes invalide pendant le polling.'); }

    const status = String(d.status || 'unknown').toLowerCase();
    if (['completed', 'succeeded', 'done'].includes(status)) {
      const urlOut = d.url || d.video_url || d.remixed_from_video_id || (d.metadata && d.metadata.url) || (d.output && d.output.url);
      if (!urlOut || !/^https?:\/\//i.test(String(urlOut))) {
        throw new Error('Vidéo terminée mais URL vidéo absente.');
      }
      return String(urlOut);
    }
    if (['failed', 'error', 'cancelled'].includes(status)) {
      const detail = typeof d.error === 'string' ? d.error : JSON.stringify(d.error || {});
      throw new Error(`Échec moteur vidéo: ${detail.slice(0, 500)}`);
    }

    if (attempt % 6 === 0) console.log(`[V11] Poll ${videoId}: ${status} ${d.progress ?? ''}`);
    await sleep(5000);
  }
  throw new Error('Délai maximal dépassé (15 minutes).');
}

let workerBusy = false;

async function processJobs() {
  if (workerBusy) return;
  const serverKey = process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!serverKey) return;

  const job = Object.values(jobs).find(j => j.status === 'queued' || j.status === 'processing');
  if (!job) return;

  workerBusy = true;
  try {
    job.status = 'processing';
    job.updatedAt = Date.now();
    saveJobs(jobs);

    for (let sceneIndex = 0; sceneIndex < job.scenes.length; sceneIndex++) {
      const scene = job.scenes[sceneIndex];
      scene.index = sceneIndex;
      if (scene.status === 'done') continue;
      if (job.status === 'cancelled') break;

      // IMPORTANT: scene 1 keeps its original reference.
      // Scene N+1 receives the exact last frame of scene N.
      if (sceneIndex > 0) {
        const previous = job.scenes[sceneIndex - 1];
        if (!previous.videoUrl) {
          scene.status = 'failed';
          scene.error = 'La scène précédente n’a pas produit de vidéo.';
          job.status = 'failed';
          saveJobs(jobs);
          break;
        }

        try {
          const framePath = await extractLastFrameToFile(previous.videoUrl, job.id, sceneIndex - 1);
          const publicUrl = registerAsset(job, framePath, 'jpg', job.publicBaseUrl);
          scene.imageUrl = publicUrl;
          scene.referenceSource = 'last-frame-of-previous-scene';
          scene.lastFramePath = framePath;
          job.updatedAt = Date.now();
          saveJobs(jobs);
          console.log(`[V11] Scene ${sceneIndex + 1}: chained to last frame of scene ${sceneIndex}`);
        } catch (e) {
          scene.status = 'failed';
          scene.error = `Extraction dernière frame : ${e.message}`;
          job.status = 'failed';
          job.updatedAt = Date.now();
          saveJobs(jobs);
          break;
        }
      }

      scene.status = 'processing';
      job.updatedAt = Date.now();
      saveJobs(jobs);

      try {
        const videoId = await createVideoTask(scene, { get: () => '' });
        scene.videoId = videoId;
        job.updatedAt = Date.now();
        saveJobs(jobs);

        scene.videoUrl = await pollVideo(videoId, { get: () => '' });
        scene.status = 'done';
        scene.error = null;
        job.updatedAt = Date.now();
        saveJobs(jobs);

        // Pre-extract the next reference immediately after completion.
        if (sceneIndex < job.scenes.length - 1) {
          try {
            const framePath = await extractLastFrameToFile(scene.videoUrl, job.id, sceneIndex);
            const nextScene = job.scenes[sceneIndex + 1];
            nextScene.imageUrl = registerAsset(job, framePath, 'jpg', job.publicBaseUrl);
            nextScene.referenceSource = 'last-frame-of-previous-scene';
            nextScene.lastFramePath = framePath;
            job.updatedAt = Date.now();
            saveJobs(jobs);
            console.log(`[V11] Prepared continuity frame for scene ${sceneIndex + 2}`);
          } catch (e) {
            scene.status = 'failed';
            scene.error = `Préparation continuité : ${e.message}`;
            job.status = 'failed';
            job.updatedAt = Date.now();
            saveJobs(jobs);
            break;
          }
        }
      } catch (e) {
        scene.status = 'failed';
        scene.error = e.message;
        job.status = 'failed';
        job.updatedAt = Date.now();
        saveJobs(jobs);
        break;
      }
    }

    if (job.status !== 'failed' && job.status !== 'cancelled') {
      job.status = job.scenes.every(s => s.status === 'done') ? 'completed' : 'queued';
    }
    job.updatedAt = Date.now();
    saveJobs(jobs);
  } finally {
    workerBusy = false;
  }
}

// ========================= API =========================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: 'V11',
    workerConfigured: Boolean(process.env.AGNES_API_KEY || AGNES_API_KEY),
    model: MODEL_VIDEO,
    apiBase: API_BASE,
    pollBase: POLL_BASE,
    ffmpegConfigured: Boolean(ffmpegPath?.path),
    frameRule: '8n+1 <= 441',
    defaultFrameRate: DEFAULT_FRAME_RATE
  });
});

app.post('/api/jobs', requirePrivateAuth, (req, res) => {
  const key = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!key) return res.status(503).json({ error: 'AGNES_API_KEY non configurée sur le serveur.' });

  const { scenes } = req.body || {};
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'Aucune scène.' });
  if (scenes.length > 20) return res.status(400).json({ error: 'Trop de scènes.' });
  if (!ffmpegPath?.path) return res.status(503).json({ error: 'FFmpeg serveur indisponible. Ajoute @ffmpeg-installer/ffmpeg dans package.json.' });

  let publicBaseUrl;
  try { publicBaseUrl = getPublicBase(req); }
  catch (e) { return res.status(503).json({ error: e.message }); }

  const id = crypto.randomUUID();
  const normalizedScenes = scenes.map((s, index) => {
    const requestedFrames = Number(s.frames) || 441;
    const requestedFps = Number(s.frameRate) || DEFAULT_FRAME_RATE;
    const norm = normalizeFrames(requestedFrames, requestedFps);
    const originalImage = s.image || s.referenceImage || null;
    let imageUrl = null;
    let assetMeta = null;

    const parsed = parseImageInput(originalImage);
    if (parsed?.type === 'url') imageUrl = parsed.value;
    if (parsed?.type === 'data') {
      assetMeta = writeReferenceAsset(id, index, originalImage);
      if (assetMeta) imageUrl = `${publicBaseUrl}/api/assets/${encodeURIComponent(id)}/${encodeURIComponent(assetMeta.token)}`;
    }

    return {
      index,
      prompt: String(s.prompt || ''),
      // imageUrl is the URL Agnes receives. Scene 1 keeps the supplied image.
      // Scenes 2+ are overwritten by the previous scene's last frame.
      imageUrl,
      originalImageProvided: Boolean(originalImage),
      frames: norm.frames,
      frameRate: norm.fps,
      requestedSeconds: norm.seconds,
      status: 'pending',
      videoId: null,
      videoUrl: null,
      error: null,
      referenceSource: imageUrl ? 'initial-reference' : 'text-only'
    };
  });

  jobs[id] = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    publicBaseUrl,
    assets: {},
    scenes: normalizedScenes
  };

  // Re-register initial data-url assets in the job token map.
  for (const scene of normalizedScenes) {
    if (scene.imageUrl && scene.imageUrl.startsWith(publicBaseUrl + '/api/assets/')) {
      const token = scene.imageUrl.split('/').pop();
      const dir = path.join(ASSET_DIR, id);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const matching = files.find(name => name.includes(token));
      if (matching) {
        const ext = path.extname(matching).slice(1).toLowerCase();
        jobs[id].assets[token] = { filePath: path.join(dir, matching), ext };
      }
    }
  }

  saveJobs(jobs);
  processJobs();
  return res.status(202).json({ id, status: 'queued', version: 'V11' });
});

app.get('/api/jobs/:id', requirePrivateAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  return res.json(safeJob(job));
});

app.post('/api/jobs/:id/cancel', requirePrivateAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.status === 'completed') return res.status(409).json({ error: 'Déjà terminé' });
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  saveJobs(jobs);
  return res.json(safeJob(job));
});

app.get(/.*/, (req, res) => {
  if (validAuthToken(getCookie(req, 'csp_auth'))) return res.sendFile(INDEX_FILE);
  return res.sendFile(LOGIN_FILE);
});

app.listen(PORT, () => {
  console.log(`Cinema V11 listening on :${PORT}`);
  console.log(`Agnes create: ${API_BASE}/videos`);
  console.log(`Agnes poll: ${POLL_BASE}?video_id=...&model_name=${MODEL_VIDEO}`);
  console.log(`FFmpeg: ${ffmpegPath?.path || 'UNAVAILABLE'}`);
  console.log(`Default video timing: ${DEFAULT_FRAME_RATE}fps, max 441 frames`);
});

setInterval(processJobs, 3000);
processJobs();
