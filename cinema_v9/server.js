import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.AGNES_API_BASE || 'https://api.agnes.com';
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
    const password = String(req.body?.password || '');
    const expectedHash = process.env.APP_PASSWORD_SHA256 || '';
    const suppliedHash = hashPassword(password);
    if (!expectedHash || !process.env.AUTH_SECRET) return res.status(503).json({ ok: false, error: 'AUTH_NOT_CONFIGURED' });
    if (!timingSafeEqualHex(suppliedHash, expectedHash)) return res.status(401).json({ ok: false, error: 'INVALID_PASSWORD' });
    const token = makeAuthToken();
    res.setHeader('Set-Cookie', `csp_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
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

const MODEL_VIDEO = 'agnes-video-v2.0';
const FRAME_RATE = 24;
const DATA_DIR = path.join(process.cwd(), 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

setupPrivateAuthRoutes();
app.use(express.json({ limit: '25mb' }));
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

const execFileAsync = promisify(execFile);

async function extractLastFrameDataUrl(videoUrl) {
  const tempDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  const id = crypto.randomUUID();
  const inputPath = path.join(tempDir, `${id}.mp4`);
  const outputPath = path.join(tempDir, `${id}.jpg`);

  try {
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`Téléchargement vidéo HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Vidéo vide');

    fs.writeFileSync(inputPath, buffer);

    // Extract a frame very close to the end of the generated clip.
    // -sseof seeks from the end, so this works without knowing the duration.
    try {
      await execFileAsync(ffmpegPath.path, [
        '-y',
        '-sseof', '-0.20',
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath
      ]);
    } catch (_) {
      // Fallback for very short clips where -0.20s is outside the valid range.
      await execFileAsync(ffmpegPath.path, [
        '-y',
        '-sseof', '-1',
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath
      ]);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg n’a pas produit la dernière frame');
    }

    const jpg = fs.readFileSync(outputPath);
    return 'data:image/jpeg;base64,' + jpg.toString('base64');
  } finally {
    try { fs.unlinkSync(inputPath); } catch (_) {}
    try { fs.unlinkSync(outputPath); } catch (_) {}
  }
}


async function createVideoTask(scene, req){
  const apiKeyToUse = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  const body = { model: MODEL_VIDEO, prompt: scene.prompt, num_frames: scene.frames, frame_rate: FRAME_RATE };
  if (scene.image) body.image = scene.image;
  const res = await fetch(API_BASE + '/videos', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization':'Bearer '+ apiKeyToUse
    },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Creation HTTP '+res.status+' — '+txt.slice(0,300));
  const data = JSON.parse(txt);
  const id = data.video_id || data.id || data.task_id;
  if (!id) throw new Error("L'API n'a pas retourné de video_id");
  return id;
}

async function pollVideo(videoId, req){
  const apiKeyToUse = getApiKeyForRequest(req) || process.env.AGNES_API_KEY || AGNES_API_KEY;
  for(let attempt=0; attempt<120; attempt++){
    const res = await fetch(API_BASE + '/videos/status?video_id='+encodeURIComponent(videoId)+'&model_name='+encodeURIComponent(MODEL_VIDEO), {
      headers:{'Authorization':'Bearer '+ apiKeyToUse}
    });
    const txt = await res.text();
    if(!res.ok) throw new Error('Polling HTTP '+res.status+' — '+txt.slice(0,250));
    const d = JSON.parse(txt);
    const status = d.status || 'unknown';
    if(['completed','succeeded','done'].includes(status)){
      const url = (d.metadata && d.metadata.url) || d.url || (d.output && d.output.url);
      if(!url) throw new Error('Vidéo terminée mais URL absente');
      return url;
    }
    if(['failed','error','cancelled'].includes(status)) throw new Error('Échec moteur vidéo: '+status);
    await sleep(5000);
  }
  throw new Error('Délai maximal dépassé');
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
    for(let sceneIndex = 0; sceneIndex < job.scenes.length; sceneIndex++){
      const scene = job.scenes[sceneIndex];
      if(scene.status==='done') continue;

      // Permanent sequential continuity:
      // Scene 1 uses the user's master reference.
      // Every following scene uses the last frame extracted from the
      // previously generated scene.
      if(sceneIndex > 0){
        const previousScene = job.scenes[sceneIndex - 1];
        if(!previousScene.videoUrl){
          scene.status='failed';
          scene.error='Impossible de continuer : la scène précédente n’a pas d’URL vidéo.';
          job.status='failed';
          job.updatedAt=Date.now();
          saveJobs(jobs);
          break;
        }

        try{
          scene.image = await extractLastFrameDataUrl(previousScene.videoUrl);
          scene.referenceSource = 'last-frame-of-previous-scene';
          job.updatedAt=Date.now();
          saveJobs(jobs);
        }catch(e){
          scene.status='failed';
          scene.error='Extraction dernière frame : ' + e.message;
          job.status='failed';
          job.updatedAt=Date.now();
          saveJobs(jobs);
          break;
        }
      }

      scene.status='processing'; job.updatedAt=Date.now(); saveJobs(jobs);

      try{
        const videoId = await createVideoTask(scene, { get:()=>'' });
        scene.videoId = videoId;
        job.updatedAt=Date.now();
        saveJobs(jobs);

        scene.videoUrl = await pollVideo(videoId, { get:()=>'' });
        scene.status='done';
        scene.error=null;

        // Extract now so the next scene can start directly from this
        // exact final visual state.
        if(sceneIndex < job.scenes.length - 1){
          try{
            scene.lastFrame = await extractLastFrameDataUrl(scene.videoUrl);
            job.scenes[sceneIndex + 1].image = scene.lastFrame;
            job.scenes[sceneIndex + 1].referenceSource = 'last-frame-of-previous-scene';
          }catch(e){
            scene.status='failed';
            scene.error='Extraction dernière frame : ' + e.message;
            job.status='failed';
            job.updatedAt=Date.now();
            saveJobs(jobs);
            break;
          }
        }
      }catch(e){
        scene.status='failed'; scene.error=e.message;
        job.status='failed'; job.updatedAt=Date.now(); saveJobs(jobs);
        break;
      }

      job.updatedAt=Date.now();
      saveJobs(jobs);
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
  jobs[id]={id,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),scenes:scenes.map(s=>({prompt:String(s.prompt||''),image:s.image||null,frames:Number(s.frames)||480,status:'pending',videoUrl:null,error:null}))};
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

app.get(/.*/,(req,res)=>res.sendFile(path.join(process.cwd(),'public','index.html')));

app.listen(PORT,()=>console.log(`Cinema V9 listening on :${PORT}`));
setInterval(processJobs,3000);
processJobs();
