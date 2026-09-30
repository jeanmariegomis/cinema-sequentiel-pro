import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const PORT = Number(process.env.PORT || 10000);
const API_BASE = process.env.AGNES_API_BASE || 'https://apihub.agnes-ai.com/v1';
const POLL_BASE = process.env.AGNES_POLL_BASE || 'https://apihub.agnes-ai.com/agnesapi';
const MODEL_VIDEO = 'agnes-video-v2.0';
const FRAME_RATE = 22;
const MAX_FRAMES = 441;
const DEFAULT_FRAMES = 441;
const MAX_SCENES = 20;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const app = express();
const execFileAsync = promisify(execFile);
const ffmpegPath = ffmpegInstaller.path;

const DATA_DIR = path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'generated');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, PUBLIC_DIR, ASSETS_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// AUTH — compatible with the working Render configuration
// Uses APP_PASSWORD + AUTH_SECRET. Never expose either value.
// ============================================================
function timingSafeStringEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  if (!part) return '';
  try { return decodeURIComponent(part.slice(name.length + 1)); }
  catch { return ''; }
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
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(exp).digest('hex');
  return timingSafeStringEqual(sig, expected);
}

function requirePrivateAuth(req, res, next) {
  if (validAuthToken(getCookie(req, 'csp_auth'))) return next();
  return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
}

app.post('/api/auth/login', express.json(), (req, res) => {
  const password = String(req.body?.password || '');
  const expected = process.env.APP_PASSWORD || '';
  const secret = process.env.AUTH_SECRET || '';

  if (!expected || !secret) {
    return res.status(503).json({ ok: false, error: 'AUTH_NOT_CONFIGURED' });
  }

  if (!timingSafeStringEqual(password, expected)) {
    return res.status(401).json({ ok: false, error: 'INVALID_PASSWORD' });
  }

  const token = makeAuthToken();
  res.setHeader(
    'Set-Cookie',
    `csp_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
  );
  return res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'csp_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: validAuthToken(getCookie(req, 'csp_auth')) });
});

// ============================================================
// SERVER / FILES
// ============================================================
app.use(express.json({ limit: '30mb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveJobs(value) {
  const tmp = JOBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, JOBS_FILE);
}
let jobs = loadJobs();

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host');
  return `${proto}://${host}`;
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
      referenceSource: s.referenceSource || null
    }))
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizeFrames(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_FRAMES;
  n = Math.floor(n);
  n = Math.min(n, MAX_FRAMES);
  // Agnes requires 8n+1.
  n = 8 * Math.floor((n - 1) / 8) + 1;
  return Math.max(9, Math.min(MAX_FRAMES, n));
}

function parseDataImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { mime, ext, buffer };
}

function saveImageBuffer(buffer, ext = 'jpg') {
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const absolute = path.join(ASSETS_DIR, filename);
  fs.writeFileSync(absolute, buffer);
  return `/generated/${filename}`;
}

function saveDataImage(dataUrl) {
  const parsed = parseDataImage(dataUrl);
  if (!parsed) throw new Error('Image de référence invalide ou trop volumineuse.');
  return saveImageBuffer(parsed.buffer, parsed.ext);
}

function absoluteAssetPath(assetUrl) {
  try {
    const u = new URL(assetUrl, 'http://local.invalid');
    const pathname = decodeURIComponent(u.pathname);
    if (!pathname.startsWith('/generated/')) return null;
    const filename = path.basename(pathname);
    const target = path.join(ASSETS_DIR, filename);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(ASSETS_DIR) + path.sep)) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function downloadToFile(videoUrl, outputPath) {
  const response = await fetch(videoUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Téléchargement vidéo HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Vidéo vide.');
  fs.writeFileSync(outputPath, buffer);
}

async function extractLastFrame(videoUrl) {
  const id = crypto.randomUUID();
  const inputPath = path.join(TMP_DIR, `${id}.mp4`);
  const outputPath = path.join(TMP_DIR, `${id}.jpg`);

  try {
    await downloadToFile(videoUrl, inputPath);
    try {
      await execFileAsync(ffmpegPath, [
        '-y', '-sseof', '-0.20', '-i', inputPath,
        '-frames:v', '1', '-q:v', '2', outputPath
      ], { timeout: 120000 });
    } catch {
      await execFileAsync(ffmpegPath, [
        '-y', '-sseof', '-1', '-i', inputPath,
        '-frames:v', '1', '-q:v', '2', outputPath
      ], { timeout: 120000 });
    }

    if (!fs.existsSync(outputPath)) throw new Error('FFmpeg n’a pas produit la dernière frame.');
    const jpg = fs.readFileSync(outputPath);
    return saveImageBuffer(jpg, 'jpg');
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

function absoluteAgnesImageUrl(assetUrl) {
  const base = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}${assetUrl.startsWith('/') ? '' : '/'}${assetUrl}`;
}

function buildPrompt(scene) {
  const continuity = scene.index === 0
    ? 'This is the first scene. Establish the exact character identity from the provided reference image.'
    : 'CONTINUITY IS MANDATORY: continue from the exact final visual state of the previous scene. Preserve the same person, face, age, skin tone, hairstyle, hairline, facial proportions, body proportions, clothing, accessories and visual identity. Do not redesign or replace the character.';

  return `${scene.prompt}\n\n${continuity}\n\nAUDIO/LANGUAGE: all spoken dialogue must be in French only. Do not speak English, Arabic, Spanish, Portuguese, or any other language. No subtitles, captions, signs, labels, logos, watermarks, or generated on-screen text.\nVISUAL CONTINUITY: realistic anatomy, stable identity, stable clothing and accessories, no face morphing, no character replacement, no duplicate character unless explicitly requested.`;
}

const NEGATIVE_PROMPT = [
  'different person', 'different face', 'face morphing', 'identity drift',
  'different hairstyle', 'different hairline', 'different age', 'different skin tone',
  'different clothes', 'different accessories', 'deformed face', 'extra fingers',
  'extra limbs', 'duplicate person', 'English speech', 'Arabic speech',
  'Spanish speech', 'Portuguese speech', 'foreign language', 'subtitles',
  'captions', 'text', 'letters', 'watermark', 'logo'
].join(', ');

async function createVideoTask(scene) {
  const apiKey = process.env.AGNES_API_KEY || '';
  if (!apiKey) throw new Error('AGNES_API_KEY non configurée sur le serveur.');
  if (!scene.imageUrl) throw new Error(`Référence image absente pour la scène ${scene.index + 1}.`);

  const body = {
    model: MODEL_VIDEO,
    prompt: buildPrompt(scene),
    negative_prompt: NEGATIVE_PROMPT,
    num_frames: normalizeFrames(scene.frames),
    frame_rate: FRAME_RATE,
    image: scene.imageUrl
  };

  const response = await fetch(`${API_BASE}/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Création Agnes HTTP ${response.status} — ${text.slice(0, 500)}`);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('Réponse Agnes invalide lors de la création.'); }

  const id = data.video_id || data.id || data.task_id;
  if (!id) throw new Error("L'API Agnes n'a pas retourné d'identifiant vidéo.");
  return id;
}

async function pollVideo(videoId) {
  const apiKey = process.env.AGNES_API_KEY || '';
  if (!apiKey) throw new Error('AGNES_API_KEY non configurée sur le serveur.');

  for (let attempt = 0; attempt < 180; attempt++) {
    const url = `${POLL_BASE}?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(MODEL_VIDEO)}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`Polling Agnes HTTP ${response.status} — ${text.slice(0, 400)}`);

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Réponse Agnes invalide pendant le polling.'); }

    const status = String(data.status || data.state || 'unknown').toLowerCase();
    const videoUrl = data.url || data.video_url || data.output?.url || data.metadata?.url;

    if (['completed', 'succeeded', 'success', 'done'].includes(status) && videoUrl) {
      return videoUrl;
    }

    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const detail = data.error?.message || data.error || data.message || status;
      throw new Error(`Échec moteur vidéo: ${String(detail).slice(0, 500)}`);
    }

    await sleep(5000);
  }

  throw new Error('Délai maximal dépassé pendant la génération vidéo.');
}

let workerBusy = false;

async function processJobs() {
  if (workerBusy) return;
  if (!process.env.AGNES_API_KEY) return;

  const job = Object.values(jobs).find(j => j.status === 'queued' || j.status === 'processing');
  if (!job) return;

  workerBusy = true;
  try {
    job.status = 'processing';
    job.updatedAt = Date.now();
    saveJobs(jobs);

    for (let index = 0; index < job.scenes.length; index++) {
      const scene = job.scenes[index];
      if (scene.status === 'done') continue;
      if (job.status === 'cancelled') break;

      // --------------------------------------------------------
      // CONTINUITY CHAIN
      // Scene 1 uses its own reference image.
      // Scene 2+ uses the actual last frame of the previous scene.
      // This intentionally overrides scene 2/3 reference images when
      // sequential continuity is enabled, because Agnes' image field
      // is the actual first frame, not a separate identity reference.
      // --------------------------------------------------------
      if (index > 0) {
        const previous = job.scenes[index - 1];
        if (!previous.videoUrl) {
          scene.status = 'failed';
          scene.error = 'La scène précédente ne possède aucune vidéo terminée.';
          job.status = 'failed';
          job.updatedAt = Date.now();
          saveJobs(jobs);
          break;
        }

        try {
          if (!previous.lastFrameUrl) {
            previous.lastFrameUrl = await extractLastFrame(previous.videoUrl);
          }
          scene.imageUrl = absoluteAgnesImageUrl(previous.lastFrameUrl);
          scene.referenceSource = 'last-frame-of-previous-scene';
          if (!scene.imageUrl) {
            throw new Error('PUBLIC_BASE_URL/RENDER_EXTERNAL_URL absent : impossible de créer une URL publique.');
          }
          job.updatedAt = Date.now();
          saveJobs(jobs);
        } catch (error) {
          scene.status = 'failed';
          scene.error = `Continuité : ${error.message}`;
          job.status = 'failed';
          job.updatedAt = Date.now();
          saveJobs(jobs);
          break;
        }
      }

      scene.status = 'processing';
      scene.error = null;
      job.updatedAt = Date.now();
      saveJobs(jobs);

      try {
        const videoId = await createVideoTask(scene);
        scene.videoId = videoId;
        job.updatedAt = Date.now();
        saveJobs(jobs);

        scene.videoUrl = await pollVideo(videoId);
        scene.status = 'done';

        if (index < job.scenes.length - 1) {
          scene.lastFrameUrl = await extractLastFrame(scene.videoUrl);
          job.scenes[index + 1].imageUrl = absoluteAgnesImageUrl(scene.lastFrameUrl);
          job.scenes[index + 1].referenceSource = 'last-frame-of-previous-scene';
        }

        job.updatedAt = Date.now();
        saveJobs(jobs);
      } catch (error) {
        scene.status = 'failed';
        scene.error = error?.message || String(error);
        job.status = 'failed';
        job.updatedAt = Date.now();
        saveJobs(jobs);
        break;
      }
    }

    if (job.scenes.every(s => s.status === 'done')) {
      job.status = 'completed';
    } else if (job.status !== 'failed' && job.status !== 'cancelled') {
      job.status = 'queued';
    }

    job.updatedAt = Date.now();
    saveJobs(jobs);
  } finally {
    workerBusy = false;
  }
}

// ============================================================
// API
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: 'V11',
    workerConfigured: Boolean(process.env.AGNES_API_KEY),
    publicBaseConfigured: Boolean(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL),
    model: MODEL_VIDEO,
    frameRate: FRAME_RATE,
    defaultFrames: DEFAULT_FRAMES
  });
});

// Upload/convert a browser data-image to a public URL.
app.post('/api/assets/image', requirePrivateAuth, (req, res) => {
  try {
    const dataUrl = String(req.body?.image || '');
    const relative = saveDataImage(dataUrl);
    return res.json({ ok: true, url: `${publicBaseUrl(req)}${relative}` });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/jobs', requirePrivateAuth, (req, res) => {
  if (!process.env.AGNES_API_KEY) {
    return res.status(503).json({ error: 'AGNES_API_KEY non configurée sur le serveur.' });
  }

  const scenes = req.body?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Aucune scène.' });
  }
  if (scenes.length > MAX_SCENES) {
    return res.status(400).json({ error: `Maximum ${MAX_SCENES} scènes.` });
  }

  const baseUrl = publicBaseUrl(req);
  const id = crypto.randomUUID();

  try {
    const normalizedScenes = scenes.map((input, index) => {
      const prompt = String(input?.prompt || '').trim();
      if (!prompt) throw new Error(`Prompt vide pour la scène ${index + 1}.`);

      let imageUrl = null;
      const incomingImage = input?.image || input?.imageDataUrl || input?.referenceImage || null;

      if (incomingImage) {
        if (/^data:image\//i.test(String(incomingImage))) {
          const relative = saveDataImage(String(incomingImage));
          imageUrl = `${baseUrl}${relative}`;
        } else if (/^https?:\/\//i.test(String(incomingImage))) {
          imageUrl = String(incomingImage);
        } else {
          throw new Error(`Image de référence invalide pour la scène ${index + 1}.`);
        }
      }

      // If there is no image for scene 1, fail immediately. Scenes after
      // scene 1 will receive their image from the continuity chain.
      if (index === 0 && !imageUrl) {
        throw new Error('La scène 1 doit avoir une image de référence.');
      }

      return {
        index,
        prompt,
        originalReferenceUrl: imageUrl,
        imageUrl,
        frames: normalizeFrames(input?.frames),
        status: 'pending',
        videoId: null,
        videoUrl: null,
        lastFrameUrl: null,
        referenceSource: index === 0 ? 'scene-1-reference' : 'pending-continuity',
        error: null
      };
    });

    jobs[id] = {
      id,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      scenes: normalizedScenes
    };

    saveJobs(jobs);
    processJobs();
    return res.status(202).json({ id, status: 'queued', version: 'V11' });
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

app.get('/api/jobs/:id', requirePrivateAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable.' });
  res.json(safeJob(job));
});

app.post('/api/jobs/:id/cancel', requirePrivateAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable.' });
  if (job.status === 'completed') return res.status(409).json({ error: 'Déjà terminé.' });
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  saveJobs(jobs);
  res.json(safeJob(job));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Cinema Séquentiel Pro V11 listening on :${PORT}`);
  console.log(`APP_PASSWORD configured: ${Boolean(process.env.APP_PASSWORD)}`);
  console.log(`AUTH_SECRET configured: ${Boolean(process.env.AUTH_SECRET)}`);
  console.log(`AGNES_API_KEY configured: ${Boolean(process.env.AGNES_API_KEY)}`);
  console.log(`PUBLIC_BASE_URL: ${process.env.PUBLIC_BASE_URL ? 'configured' : 'not set (Render URL fallback)'}`);
  console.log(`Agnes create endpoint: ${API_BASE}/videos`);
  console.log(`Agnes polling endpoint: ${POLL_BASE}`);
});

setInterval(processJobs, 3000);
processJobs();
