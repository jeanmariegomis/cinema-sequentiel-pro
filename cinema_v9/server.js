import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.PORT || 10000;
const API_BASE =
  process.env.AGNES_API_BASE ||
  'https://apihub.agnes-ai.com/v1';

const app = express();
app.set('trust proxy', 1);

// ============================================================
// V9.4 PRIVATE SERVER AUTH
// ============================================================

function hashPassword(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(a, 'hex'),
      Buffer.from(b, 'hex')
    );
  } catch (_) {
    return false;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';

  const part = raw
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith(name + '='));

  return part
    ? decodeURIComponent(part.slice(name.length + 1))
    : '';
}

function makeAuthToken() {
  const exp =
    Date.now() +
    1000 * 60 * 60 * 24 * 30;

  const payload = String(exp);

  const secret =
    process.env.AUTH_SECRET || '';

  const sig = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return `${payload}.${sig}`;
}

function validAuthToken(token) {
  if (!token || !process.env.AUTH_SECRET) {
    return false;
  }

  const [exp, sig] = token.split('.');

  if (
    !exp ||
    !sig ||
    Number(exp) < Date.now()
  ) {
    return false;
  }

  const expected = crypto
    .createHmac(
      'sha256',
      process.env.AUTH_SECRET
    )
    .update(exp)
    .digest('hex');

  return timingSafeEqualHex(
    sig,
    expected
  );
}

function requirePrivateAuth(req, res, next) {
  if (
    validAuthToken(
      getCookie(req, 'csp_auth')
    )
  ) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: 'AUTH_REQUIRED'
  });
}

// ============================================================
// AUTH ROUTES
// ============================================================

function setupPrivateAuthRoutes() {

  app.post(
    '/api/auth/login',
    express.json(),
    express.urlencoded({
      extended: false
    }),
    (req, res) => {

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      const password =
        String(
          req.body?.password ?? ''
        );

      const plainPassword =
        process.env.APP_PASSWORD ?? '';

      const expectedHash =
        process.env.APP_PASSWORD_SHA256 ?? '';

      const authSecretConfigured =
        Boolean(
          process.env.AUTH_SECRET
        );

      console.log(
        '===== AUTH DEBUG ====='
      );

      console.log(
        'Password received:',
        password.length > 0
      );

      console.log(
        'Password length:',
        password.length
      );

      console.log(
        'APP_PASSWORD configured:',
        plainPassword.length > 0
      );

      console.log(
        'APP_PASSWORD length:',
        plainPassword.length
      );

      console.log(
        'APP_PASSWORD_SHA256 configured:',
        expectedHash.length > 0
      );

      console.log(
        'APP_PASSWORD_SHA256 length:',
        expectedHash.length
      );

      console.log(
        'AUTH_SECRET configured:',
        authSecretConfigured
      );

      let valid = false;

      if (plainPassword !== '') {

        valid =
          timingSafeEqualHex(
            hashPassword(password),
            hashPassword(plainPassword)
          );

        console.log(
          'Authentication method:',
          'APP_PASSWORD'
        );

      } else if (expectedHash !== '') {

        valid =
          timingSafeEqualHex(
            hashPassword(password),
            expectedHash
              .trim()
              .toLowerCase()
          );

        console.log(
          'Authentication method:',
          'APP_PASSWORD_SHA256'
        );

      } else {

        console.log(
          'Authentication method:',
          'NONE'
        );
      }

      console.log(
        'Password comparison result:',
        valid
      );

      console.log(
        '======================'
      );

      if (
        (!plainPassword &&
          !expectedHash) ||
        !authSecretConfigured
      ) {

        if (
          req.is(
            'application/x-www-form-urlencoded'
          )
        ) {
          return res.redirect(
            303,
            '/login.html?error=AUTH_NOT_CONFIGURED'
          );
        }

        return res.status(503).json({
          ok: false,
          error: 'AUTH_NOT_CONFIGURED'
        });
      }

      if (!valid) {

        if (
          req.is(
            'application/x-www-form-urlencoded'
          )
        ) {
          return res.redirect(
            303,
            '/login.html?error=INVALID_PASSWORD'
          );
        }

        return res.status(401).json({
          ok: false,
          error: 'INVALID_PASSWORD'
        });
      }

      const token =
        makeAuthToken();

      res.setHeader(
        'Set-Cookie',
        `csp_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`
      );

      console.log(
        'Authentication successful'
      );

      if (
        req.is(
          'application/x-www-form-urlencoded'
        )
      ) {
        return res.redirect(
          303,
          '/'
        );
      }

      return res.json({
        ok: true
      });
    }
  );

  app.post(
    '/api/auth/logout',
    (req, res) => {

      res.setHeader(
        'Set-Cookie',
        'csp_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
      );

      return res.json({
        ok: true
      });
    }
  );

  app.get(
    '/api/auth/status',
    (req, res) => {

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      return res.json({
        authenticated:
          validAuthToken(
            getCookie(
              req,
              'csp_auth'
            )
          )
      });
    }
  );
}

// ============================================================
// AGNES API KEY
// ============================================================

function getAgnesKey(req) {
  try {

    const fromClient =
      req.get(
        'X-Agnes-API-Key'
      );

    return (
      fromClient &&
      fromClient.trim()
    ) || '';

  } catch (_) {
    return '';
  }
}

const AGNES_API_KEY =
  process.env.AGNES_API_KEY || '';

function getApiKeyForRequest(req) {

  try {

    const key =
      getAgnesKey(req);

    if (key) {
      return key;
    }

  } catch (_) {}

  return (
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY ||
    ''
  );
}

// ============================================================
// VIDEO CONFIG
// ============================================================

// Agnes Video V2.0 protocol.
const MODEL =
  'agnes-video-v2.0';

const LEGACY_MODEL =
  'agnes-video-v2.0';

const FRAME_RATE = 24;

// Deterministic generation: the same prompt/reference/scene settings
// produce the same Agnes seed unless the client explicitly supplies one.
const AGNES_DETERMINISTIC_SEED =
  String(process.env.AGNES_DETERMINISTIC_SEED || 'true').toLowerCase() !== 'false';

const DATA_DIR =
  path.join(
    process.cwd(),
    'data'
  );

const CONTINUITY_FRAME_DIR =
  path.join(
    DATA_DIR,
    'continuity_frames'
  );

const JOBS_FILE =
  path.join(
    DATA_DIR,
    'jobs.json'
  );

const MAX_VIDEO_SECONDS = 12;
const AGNES_REQUEST_TIMEOUT_MS = 45000;
const AGNES_POLL_TIMEOUT_MS = 30000;
// Agnes free queue: process one server job at a time by default.
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Math.min(4, Number(process.env.JOB_CONCURRENCY) || 1)
);
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED_JOBS = 100;

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);

fs.mkdirSync(
  CONTINUITY_FRAME_DIR,
  {
    recursive: true
  }
);

// ============================================================
// BODY PARSER
// ============================================================

app.use(
  express.json({
    limit: '25mb'
  })
);

// ============================================================
// LOGIN PAGE
// ============================================================

app.get(
  '/login.html',
  (req, res) => {

    if (
      validAuthToken(
        getCookie(
          req,
          'csp_auth'
        )
      )
    ) {
      return res.redirect('/');
    }

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    return res.sendFile(
      path.join(
        process.cwd(),
        'public',
        'login.html'
      )
    );
  }
);

// ============================================================
// PRIVATE WEB GATE
// ============================================================

setupPrivateAuthRoutes();

app.use(
  (req, res, next) => {

    if (
      req.path.startsWith(
        '/api/auth/'
      )
    ) {
      return next();
    }

    const authCookie =
      getCookie(
        req,
        'csp_auth'
      );

    const authenticated =
      validAuthToken(
        authCookie
      );

    console.log(
      '===== PRIVATE GATE DEBUG ====='
    );

    console.log(
      'Path:',
      req.path
    );

    console.log(
      'Cookie present:',
      Boolean(authCookie)
    );

    console.log(
      'Cookie length:',
      authCookie.length
    );

    console.log(
      'Token valid:',
      authenticated
    );

    console.log(
      'AUTH_SECRET configured:',
      Boolean(
        process.env.AUTH_SECRET
      )
    );

    console.log(
      '=============================='
    );

    if (authenticated) {
      return next();
    }

    if (
      req.path.startsWith('/api/')
    ) {
      return res.status(401).json({
        ok: false,
        error: 'AUTH_REQUIRED'
      });
    }

    console.log(
      'PRIVATE GATE → REDIRECT /login.html'
    );

    return res.redirect(
      '/login.html'
    );
  }
);

// ============================================================
// STATIC FILES
// ============================================================

app.use(
  express.static(
    path.join(
      process.cwd(),
      'public'
    )
  )
);

// ============================================================
// JOB STORAGE
// ============================================================

function loadJobs() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(
        JOBS_FILE,
        'utf8'
      )
    );

    for (const job of Object.values(parsed)) {
      // Active jobs without a persisted reference cannot safely resume after restart.
      if (
        job &&
        !['completed', 'failed', 'cancelled'].includes(job.status) &&
        !job.referenceImage &&
        Array.isArray(job.scenes) &&
        job.scenes.some(scene => scene.mode === 'reference' || scene.mode === 'keyframe')
      ) {
        job.status = 'failed';        job.error = 'Job interrompu : référence vidéo absente après redémarrage du serveur.';        for (const scene of job.scenes) {
          if (scene.status !== 'done') {
            scene.status = 'failed';
            scene.error = 'Job interrompu après redémarrage du serveur.';
          }
        }
        job.updatedAt = Date.now();
      }
    }

    return parsed;

  } catch (_) {

    return {};
  }
}

function pruneJobs(jobsData) {
  const now = Date.now();
  const entries = Object.entries(jobsData)
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));

  for (const [id, job] of entries.slice(MAX_STORED_JOBS)) {
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      delete jobsData[id];
    }
  }

  for (const [id, job] of Object.entries(jobsData)) {
    if (
      ['completed', 'failed', 'cancelled'].includes(job.status) &&
      now - (job.updatedAt || job.createdAt || 0) > JOB_RETENTION_MS
    ) {
      delete jobsData[id];
    }
  }
}

function makeJobsDiskSnapshot(jobsData) {
  const snapshot = {};

  for (const [id, job] of Object.entries(jobsData)) {
    snapshot[id] = {
      ...job,
      // Never serialize the large master reference on every progress update.
      referenceImage: null,
      scenes: Array.isArray(job.scenes)
        ? job.scenes.map(scene => {
            const copy = { ...scene };
            delete copy.images;
            delete copy.first_frame;
            delete copy.last_frame;
            return copy;
          })
        : []
    };
  }

  return snapshot;
}

function persistJobsNow(jobsData) {
  const persistStartedAt = Date.now();
  const snapshot = makeJobsDiskSnapshot(jobsData);
  const tempFile = `${JOBS_FILE}.${process.pid}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(snapshot, null, 2),
    'utf8'
  );

  fs.renameSync(
    tempFile,
    JOBS_FILE
  );

  console.log(
    `[JOB PERSIST TIMING] Snapshot compact écrit en ${((Date.now() - persistStartedAt) / 1000).toFixed(3)}s`
  );
}

let saveTimer = null;
let saveInProgress = false;
let saveAgain = false;

function saveJobs(jobsData) {
  pruneJobs(jobsData);

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  if (saveInProgress) {
    saveAgain = true;
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;

    try {
      saveInProgress = true;
      persistJobsNow(jobsData);
    } catch (error) {
      console.error(
        '[JOB PERSIST ERROR]',
        error
      );
    } finally {
      saveInProgress = false;

      if (saveAgain) {
        saveAgain = false;
        saveJobs(jobsData);
      }
    }
  }, 250);
}

let jobs =
  loadJobs();

// ============================================================
// SAFE JOB
// ============================================================

function safeJob(job) {

  return {

    id:
      job.id,

    status:
      job.status,

    createdAt:
      job.createdAt,

    updatedAt:
      job.updatedAt,

    error:
      job.error || null,

    total:
      job.scenes.length,

    completed:
      job.scenes.filter(
        s => s.status === 'done'
      ).length,

    failed:
      job.scenes.filter(
        s => s.status === 'failed'
      ).length,

    scenes:
      job.scenes.map(
        (s, i) => ({

          index:
            i,

          status:
            s.status,

          videoUrl:
            s.videoUrl || null,

          videoId:
            s.videoId || null,

          model:
            s.model || null,

          referenceType:
            s.referenceType || null,

          referenceReadyForNext:
            Boolean(s.referenceReadyForNext),

          error:
            s.error || null
        })
      )
  };
}

// ============================================================
// HELPERS
// ============================================================

async function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Requête Agnes expirée après ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractHttpStatus(
  message
) {

  const match =
    String(message || '')
      .match(
        /HTTP\s+(\d{3})/i
      );

  return match
    ? Number(match[1])
    : null;
}

function isRateLimitError(
  message
) {

  const text =
    String(message || '')
      .toLowerCase();

  return (
    text.includes(
      'rate_limit'
    ) ||
    text.includes(
      'rate limit'
    ) ||
    text.includes(
      'rate_limit_exceeded'
    ) ||
    text.includes(
      'you’ve reached the api rate limit'
    ) ||
    text.includes(
      "you've reached the api rate limit"
    )
  );
}

function isQueueFullError(
  message
) {

  const text =
    String(message || '')
      .toLowerCase();

  return (
    text.includes(
      'video_queue_full'
    ) ||
    text.includes(
      'video queue is full'
    )
  );
}

// ============================================================
// VALID LEGACY FRAME COUNT
// ============================================================
//
// Agnes legacy model requires:
// num_frames = 8 * n + 1
//
// 240 -> 241
// 288 -> 289
// 192 -> 193
// ============================================================

function normalizeSeedPrompt(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fingerprintImage(value) {
  const image = String(value || '').trim();

  if (!image) {
    return '';
  }

  // For data URLs, hash the decoded image bytes so harmless metadata/prefix
  // differences do not change the deterministic seed.
  const match = image.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);

  if (match) {
    try {
      return crypto
        .createHash('sha256')
        .update(Buffer.from(match[2], 'base64'))
        .digest('hex');
    } catch (_) {}
  }

  return crypto
    .createHash('sha256')
    .update(image, 'utf8')
    .digest('hex');
}

function makeDeterministicSeed(scene, prompt, images, mode, dimensions, validFrames) {
  if (!AGNES_DETERMINISTIC_SEED) {
    return null;
  }

  const explicitSeed = Number(scene.seed);
  if (Number.isSafeInteger(explicitSeed) && explicitSeed >= 0) {
    return {
      seed: explicitSeed,
      promptHash: null,
      imageHashes: []
    };
  }

  const normalizedPrompt = normalizeSeedPrompt(prompt);
  const imageFingerprints = images
    .map(fingerprintImage)
    .filter(Boolean);

  const seedMaterial = JSON.stringify({
    prompt: normalizedPrompt,
    images: imageFingerprints,
    mode: String(mode || '').trim().toLowerCase(),
    width: dimensions.width,
    height: dimensions.height,
    frames: validFrames,
    frame_rate: FRAME_RATE
  });

  const seedDigest = crypto
    .createHash('sha256')
    .update(seedMaterial, 'utf8')
    .digest();

  return {
    seed: seedDigest.readUInt32BE(0),
    promptHash: crypto
      .createHash('sha256')
      .update(normalizedPrompt, 'utf8')
      .digest('hex')
      .slice(0, 16),
    imageHashes: imageFingerprints.map(hash => hash.slice(0, 16))
  };
}

function buildActionIntegrityPrompt(prompt) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();
  const rules = [
    'ACTION INTEGRITY LOCK: execute the exact action described in the scene prompt and nothing else. Identify the acting subject, the manipulated object, the intended target, the contact point, and the direction of movement before animating. The hands, tools, objects, liquid, and body must remain physically connected to the intended action.',
    'The action must have a clear cause-and-effect sequence: the subject visibly holds or contacts the correct object, moves it toward the exact target named in the prompt, performs the requested action on that target, and keeps the movement aligned with that target for the entire action. Never redirect the action toward the table, floor, empty space, another object, or another person unless explicitly requested.',
    'OBJECT AND TARGET LOCK: preserve the identity, position, size, orientation, and physical relationship of important props. Do not swap objects, duplicate objects, move an object to an unintended location, or invent a different target. Maintain believable contact, gravity, collision, trajectory, and hand placement.',
    'If the prompt describes pouring, the container must remain directly above the named receiving container or target, the liquid stream must stay continuously inside that target, and the liquid must never spill onto the table, countertop, floor, clothing, or surrounding area unless the prompt explicitly requests a spill.',
    'If the prompt describes mixing, stirring, whisking, cutting, opening, closing, taking, placing, giving, receiving, picking up, putting down, or looking at something, the subject must visibly interact with the exact named object or target and complete the described action. Do not substitute another object or target.',
    'Do not introduce an unintended action merely because it is visually plausible. The written scene instruction has priority over generic animation habits.'
  ];
  if (/(vers|pour|lait|liquide|boisson|eau|jus)/i.test(lower)) {
    rules.push('POURING SAFETY LOCK: if liquid is being poured, show the receiving bowl, cup, glass, pan, or other named container clearly under the pouring stream before the stream begins. Keep the stream centered over the receiving container until pouring ends. ZERO liquid on the table or countertop.');
  }
  if (/(m[ée]lange|remue|remuer|fouet|touille|touiller|stir|mix)/i.test(lower)) {
    rules.push('MIXING LOCK: keep the utensil visibly inside the named bowl, pan, or container during mixing. The utensil must not drift onto the table or into empty space.');
  }
  return rules.join('\n');
}

function buildConsistencyPrompt(prompt, visualBible = '') {
  const bible = String(visualBible || '').trim();
  const lockedBible = bible
    ? 'SERVER-LOCKED VISUAL BIBLE — SAME IDENTITY/ENVIRONMENT RULES FOR EVERY SCENE:\n' + bible
    : 'SERVER-LOCKED VISUAL BIBLE: none supplied; rely on the supplied reference image and scene prompt.';

  return [
    'VISUAL CONTINUITY LOCK: preserve the exact identity and appearance of every existing character throughout the entire shot and across the entire sequence.',
    'FACIAL IDENTITY LOCK: preserve exact face shape, facial proportions, eye shape/color, eyebrows, eyelids, nose, lips, jawline, freckles, skin tone, age and distinctive facial features. Never redraw, beautify or replace the character with a different person.',
    'HAIR IDENTITY LOCK: hairstyle is a fixed biometric identifier. Preserve exact hairline, parting, length, curl/wave pattern, curl size, density, volume, silhouette, color, highlights, texture and distinctive loose strands. Never shorten, lengthen, straighten, tighten curls, change the part, change the hairline, recolor the hair or alter the silhouette unless explicitly requested.',
    'BODY AND CLOTHING LOCK: preserve exact body proportions, shoulder width, silhouette, age, clothing, colors, accessories and distinctive physical details. Never make the character suddenly muscular, extremely thin, younger, older or differently proportioned.',
    'ENVIRONMENT LOCK: preserve exact architecture, important props, spatial layout, time of day, lighting direction, color palette and visual style established by the reference and visual bible unless explicitly changed.',
    'ANIMAL LOCK: if an animal is present, preserve exact species, face, fur/feather pattern, colors, eyes, ears, size, body proportions and silhouette. Never clone, duplicate or replace it.',
    'REALISTIC CINEMATIC MOTION: use natural anatomy, believable weight/inertia, realistic hands and facial motion, natural eye focus/blinking, coherent shadows/reflections, cinematic depth of field and restrained camera movement.',
    'The supplied reference image defines existing identity and appearance. The scene prompt defines the intended action and camera movement. Animate the existing subject instead of inventing a replacement.',
    lockedBible,
    'AUDIO PRESENCE LOCK: unless the scene explicitly requests silence/no sound, include an audible cinematic sound bed or instrumental score. Never leave a scene randomly silent.',
    'AUDIO CONTINUITY LOCK: when multiple scenes belong to one sequence, preserve a coherent recurring sonic identity, related mood, instrumentation family, production character and stable perceived volume. No unrelated genre changes or random audio drops.',
    'AUDIO SPEECH LOCK: only scripted dialogue may be spoken. No invented narration, singing, conversation, human voice, animal speech or lip-sync. A subject with no scripted dialogue remains silent.',
    buildActionIntegrityPrompt(prompt),
    'SCENE INSTRUCTIONS:\n' + prompt
  ].join('\n\n');
}

function buildContinuationPrompt(prompt, visualBible = '') {
  return [
    'HARD CONTINUATION START: this scene MUST begin from the supplied image as the exact final frame of the immediately previous scene. Treat the supplied image as frame 0 of this shot.',
    'FIRST 0.5 SECOND CONTINUITY LOCK: keep camera framing, scale, viewpoint, character positions, body pose, hand positions, hair silhouette, facial expression, clothing, props and lighting visually locked before introducing new motion.',
    'DO NOT RESET OR RECOMPOSE: do not restart from the master reference image, do not redesign the character, do not move the character to a new location, and do not replace the supplied starting frame with a newly invented opening.',
    'HAIR AND FACE MUST MATCH THE SUPPLIED FRAME: hair length, curl pattern, hairline, volume, color, face shape, eyes and all visible identity details must remain unchanged while the new action begins.',
    'After the locked opening moment, continue forward only according to the new scene action. The previous-scene frame is the temporal starting state; the visual bible is the permanent identity/environment constraint.',
    buildConsistencyPrompt(prompt, visualBible)
  ].join('\n\n');
}

function getValidLegacyFrames(
  requestedFrames
) {

  let frames =
    Number(requestedFrames);

  if (
    !Number.isFinite(frames) ||
    frames <= 0
  ) {
    frames =
      8 * FRAME_RATE;
  }

  frames =
    Math.max(
      9,
      Math.round(frames)
    );

  const n =
    Math.round(
      (frames - 1) / 8
    );

  return (
    8 * Math.max(0, n) +
    1
  );
}

// ============================================================
// CREATE VIDEO TASK
// ============================================================

async function createVideoTask(
  scene,
  req
) {

  const apiKeyToUse =
    getApiKeyForRequest(req) ||
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  if (!apiKeyToUse) {

    throw new Error(
      'AGNES_API_KEY non configurée'
    );
  }

  const prompt =
    String(
      scene.prompt || ''
    ).trim();

  if (!prompt) {

    throw new Error(
      'Prompt vidéo vide'
    );
  }

  const rawSeconds =
    Number(
      scene.seconds ??
      (
        Number(scene.frames)
          ? Number(scene.frames) /
            FRAME_RATE
          : 8
      )
    );

  const seconds =
  Math.max(
    4,
    Math.min(
      MAX_VIDEO_SECONDS,
      Math.round(
        rawSeconds
      )
    )
  );

  const requestedFrames =
    Number(scene.frames) ||
    Math.round(
      seconds *
      FRAME_RATE
    );

  const firstFrame =
    scene.first_frame ||
    null;

  const lastFrame =
    scene.last_frame ||
    null;

  const images =
    Array.isArray(
      scene.images
    )
      ? scene.images
          .filter(Boolean)
          .slice(0, 5)
      : [];

  let mode =
    String(
      scene.mode || ''
    )
      .trim()
      .toLowerCase();

  if (
    ![
      'text',
      'keyframe',
      'reference'
    ].includes(mode)
  ) {
    mode = '';
  }

  if (!mode) {

    mode =
      (
        firstFrame ||
        lastFrame
      )
        ? 'keyframe'
        : (
            images.length
              ? 'reference'
              : 'text'
          );
  }

  // ==========================================================
  // PRIMARY BODY — AGNES VIDEO V2.0
  // ==========================================================
  //
  // V2.0 uses num_frames + frame_rate for duration.
  // num_frames must be <= 441 and satisfy 8n + 1.
  //

  const validFrames =
    getValidLegacyFrames(
      requestedFrames
    );

  function getVideoDimensions(aspectRatio) {
    const ratio =
      String(aspectRatio || '9:16').trim();

    if (ratio === '16:9') {
      return {
        width: 1280,
        height: 720
      };
    }

    if (ratio === '1:1') {
      return {
        width: 1024,
        height: 1024
      };
    }

    // Portrait default for TikTok / Shorts.
    return {
      width: 720,
      height: 1280
    };
  }

  const dimensions =
    getVideoDimensions(
      scene.aspect_ratio
    );

  const seedInfo =
    makeDeterministicSeed(
      scene,
      prompt,
      images,
      mode,
      dimensions,
      validFrames
    );

  const deterministicSeed =
    seedInfo === null
      ? null
      : seedInfo.seed;

  const sequenceIndex = Number.isInteger(Number(scene.sequenceIndex))
    ? Number(scene.sequenceIndex)
    : (Number.isInteger(Number(scene.index)) ? Number(scene.index) : 0);

  const visualBible = String(scene.visualBible || '').trim();

  const continuityPrompt =
    sequenceIndex > 0
      ? buildContinuationPrompt(prompt, visualBible)
      : buildConsistencyPrompt(prompt, visualBible);

  const primaryBody = {

    model:
      MODEL,

    prompt:
      continuityPrompt,

    width:
      dimensions.width,

    height:
      dimensions.height,

    num_frames:
      validFrames,

    frame_rate:
      FRAME_RATE,
    ...(deterministicSeed !== null
      ? { seed: deterministicSeed }
      : {}),

    negative_prompt:
      'subtitles, captions, closed captions, on-screen text, written text, letters, words, logos, watermark, UI, duplicate person, extra person, duplicate animal, extra animal, second cat, cloned cat, unrequested talking animal, animal lip-sync without scripted dialogue, unrequested human voice, unrequested narration, unrequested speech, extra fingers, deformed hands, distorted face, identity drift, sudden character change, costume change, background change, character redesign, face replacement, facial drift, body proportion change, age change, hairstyle change, hair length change, hairline change, curl pattern change, hair silhouette change, skin tone change, clothing change, prop duplication, object morphing, background morphing, geometry warping, flicker, jitter, frame-to-frame inconsistency, temporal discontinuity, unnatural anatomy, rubbery motion, floating objects, impossible physics, oversmoothed skin, waxy skin, plastic skin, doll face, artificial CGI look, 3D render look, cartoon look, game-engine look, excessive sharpening'  };

  if (mode === 'keyframe') {
    const keyframeImages = [
      firstFrame,
      lastFrame
    ].filter(Boolean);

    if (keyframeImages.length >= 2) {
      primaryBody.extra_body = {
        image:
          keyframeImages,
        mode:
          'keyframes'
      };
    } else if (keyframeImages.length === 1) {
      primaryBody.image =
        keyframeImages[0];
    } else if (images.length) {
      primaryBody.image =
        images[0];
    } else {
      throw new Error(
        'Mode keyframe sélectionné sans image de départ ou de fin'
      );
    }
  }

  if (mode === 'reference') {
    if (!images.length) {
      throw new Error(
        'Mode reference sélectionné sans image de référence'
      );
    }

    // V2.0 image-to-video uses a direct reference image.
    primaryBody.image =
      images[0];
  }


    // ==========================================================
  // POST HELPER
  // ==========================================================

  async function postVideo(
    body,
    label
  ) {
    console.log(
      '[VIDEO CREATE]',
      label,
      JSON.stringify({

        model:
          body.model,

        mode:
          body.extra_body?.mode ||
          (body.image ? 'img2video' : 'text2video'),

        duration_seconds:
          body.num_frames && body.frame_rate
            ? (body.num_frames / body.frame_rate).toFixed(3)
            : null,

        num_frames:
          body.num_frames ||
          null,

        width:
          body.width ||
          null,

        height:
          body.height ||
          null,

        imageCount:
          Array.isArray(body.extra_body?.image)
            ? body.extra_body.image.length
            : (body.image ? 1 : 0),

        seed:
          body.seed ?? null,

        promptHash:
          seedInfo?.promptHash ?? null,

        imageHashes:
          seedInfo?.imageHashes ?? []
      })
    );

    const createStartedAt = Date.now();
    const response =
      await fetchWithTimeout(
        `${API_BASE}/videos`,
        {
          method:
            'POST',

          headers: {

            'Content-Type':
              'application/json',

            'Authorization':
              `Bearer ${apiKeyToUse}`
          },

          body: JSON.stringify(body)
        },
        AGNES_REQUEST_TIMEOUT_MS
      );

    const txt =
      await response.text();
      console.log(
  `[VIDEO TIMING] Création API ${label}: ${((Date.now() - createStartedAt) / 1000).toFixed(1)}s`
);

    if (!response.ok) {

      throw new Error(
        `Creation vidéo HTTP ${response.status}: ${txt.slice(0, 1500)}`
      );
    }

    let data;

    try {

      data =
        JSON.parse(txt);

    } catch (_) {

      throw new Error(
        `Réponse Agnes invalide: ${txt.slice(0, 1500)}`
      );
    }

    const videoId =
      data.video_id ||
      data.id ||
      data.task_id;

    if (!videoId) {

      throw new Error(
        `Agnes n'a pas retourné de video_id: ${JSON.stringify(data).slice(0, 1500)}`
      );
    }

    console.log(
      '[VIDEO CREATED]',
      videoId,
      'model=',
      body.model
    );

    return {

      videoId:
        videoId,

      model:
        body.model
    };
  }

  // ==========================================================
  // PRIMARY REQUEST WITH QUEUE RETRIES
  // ==========================================================

  let primaryError = null;
// Avoid repeated video-creation POSTs that can consume the free API quota
// or create duplicate work when Agnes is temporarily unavailable.
const queueRetryDelays = [];
const rateLimitRetryDelays = [];

  for (
    let attempt = 0;
    attempt <= queueRetryDelays.length;
    attempt++
  ) {

    try {

      return await postVideo(
        primaryBody,
        attempt === 0
          ? 'primary'
          : `primary-retry-${attempt}`
      );

    } catch (error) {

      primaryError =
        error;

      const message =
        String(
          error?.message ||
          error
        );

      // ========================================================
      // 429 = RATE LIMIT
      // ========================================================
      //
      // NEVER try to bypass it.
      // NEVER fallback to another model.
      // ========================================================

      if (
        isRateLimitError(
          message
        ) ||
        extractHttpStatus(
          message
        ) === 429
      ) {

        if (
  attempt <
  rateLimitRetryDelays.length
) {

  const delay =
    rateLimitRetryDelays[
      attempt
    ];

  console.warn(
    `[VIDEO RETRY] Limite API Agnes atteinte. Nouvelle tentative dans ${delay / 1000}s.`
  );

  await sleep(
    delay
  );

  continue;
}

throw new Error(
  `Limite API gratuite atteinte. Veuillez réessayer plus tard.`
);
      }

      // ========================================================
      // 503 QUEUE FULL
      // ========================================================

      if (
        (
          isQueueFullError(
            message
          ) ||
          extractHttpStatus(
            message
          ) === 503
        ) &&
        attempt <
          queueRetryDelays.length
      ) {

        const delay =
          queueRetryDelays[
            attempt
          ];

        console.warn(
          `[VIDEO RETRY] File Agnes pleine. Nouvelle tentative dans ${delay / 1000}s.`
        );

        await sleep(
          delay
        );

        continue;
      }

      break;
    }
  }

  // ==========================================================
  // PRIMARY FAILED
  // ==========================================================

  const primaryMessage =
    String(
      primaryError?.message ||
      primaryError
    );

  // Queue full after all retries:
  // do NOT use the legacy model automatically.
  if (
    isQueueFullError(
      primaryMessage
    ) ||
    extractHttpStatus(
      primaryMessage
    ) === 503
  ) {

    throw new Error(
      `Agnes est actuellement saturé. ${primaryMessage}`
    );
  }

  // Rate limit:
  // never fallback.
  if (
    isRateLimitError(
      primaryMessage
    ) ||
    extractHttpStatus(
      primaryMessage
    ) === 429
  ) {

    throw new Error(
      `Limite API gratuite atteinte, veuillez réessayer plus tard.`
    );
  }

  // V2.0 is the single supported creation protocol.
  // Never submit a second POST after a failed V2.0 creation.
  throw primaryError;
}

// ============================================================
// POLL VIDEO
// ============================================================

async function pollVideo(
  videoId,
  req,
  model = MODEL
) {
    const pollStartedAt = Date.now();
  let pollAttempts = 0;

  const apiKeyToUse =
    getApiKeyForRequest(req) ||
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  if (!apiKeyToUse) {

    throw new Error(
      'AGNES_API_KEY non configurée'
    );
  }

  // Adaptive polling: stay responsive when progress moves,
  // but slow down when Agnes keeps the same progress to reduce 429s.
  // The client-side progress tracking is unchanged.
  const maxAttempts =
    450;

  const basePollDelay =
    2000;

  let lastProgress = null;
  let unchangedProgressPolls = 0;
  let rateLimitCount = 0;

  function getAdaptivePollDelay(progress) {
    if (progress == null) {
      return basePollDelay;
    }

    if (lastProgress === progress) {
      unchangedProgressPolls++;
    } else {
      unchangedProgressPolls = 0;
      lastProgress = progress;
    }

    if (unchangedProgressPolls >= 6) {
      return 6000;
    }

    if (unchangedProgressPolls >= 3) {
      return 4000;
    }

    return basePollDelay;
  }

  function getRetryAfterMs(response) {
    const retryAfter = response.headers.get('retry-after');

    if (!retryAfter) {
      return null;
    }

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30000, Math.max(1000, Math.round(seconds * 1000)));
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        30000,
        Math.max(1000, retryAt - Date.now())
      );
    }

    return null;
  }

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    pollAttempts++;
    const url =
      `${API_BASE.replace(
        /\/v1\/?$/,
        ''
      )}` +
      `/agnesapi?video_id=${encodeURIComponent(
        videoId
      )}` +
      `&model_name=${encodeURIComponent(
        model
      )}`;

    let response;

try {
  response =
    await fetchWithTimeout(
      url,
      {
        method:
          'GET',

        headers: {
          'Authorization':
            `Bearer ${apiKeyToUse}`
        }
      },
      AGNES_POLL_TIMEOUT_MS
    );
} catch (fetchError) {
  console.warn(
    `[VIDEO POLL] Erreur réseau temporaire: ${fetchError?.message || fetchError}. Nouvelle tentative dans 10 secondes.`
  );

  await sleep(10000);
  continue;
}

    const txt =
      await response.text();

    if (!response.ok) {

      if (response.status === 429 || response.status === 503) {
        const retryAfterMs =
          getRetryAfterMs(response);

        rateLimitCount++;

        // Prefer Agnes' Retry-After when supplied. Otherwise use a
        // controlled backoff so repeated 429s do not create a tight loop.
        const fallbackDelay =
          Math.min(
            30000,
            rateLimitCount <= 1
              ? 10000
              : rateLimitCount === 2
                ? 20000
                : 30000
          );

        const delay =
          retryAfterMs ?? fallbackDelay;

        console.warn(
          `[VIDEO POLL] Agnes répond ${response.status}. Nouvelle tentative dans ${Math.round(delay / 1000)} secondes.`
        );

        await sleep(delay);
        continue;
      }

      throw new Error(
        `Polling HTTP ${response.status}: ${txt.slice(0, 1200)}`
      );
    }

    let data;

    try {

      data =
        JSON.parse(txt);

    } catch (_) {

      throw new Error(
        `Réponse polling Agnes invalide: ${txt.slice(0, 1200)}`
      );
    }

    const status =
      String(
        data.status || ''
      ).toLowerCase();

    console.log(
      `[VIDEO POLL] ${videoId} model=${model} → ${status || 'unknown'} ${
        data.progress != null
          ? data.progress + '%'
          : ''
      }`
    );

    // ========================================================
    // COMPLETED
    // ========================================================

    if (
      [
        'completed',
        'succeeded',
        'success',
        'done'
      ].includes(status)
    ) {

      const videoUrl =
        data.url ||
        data.video_url ||
        data.output?.url ||
        data.output?.video_url ||
        data.data?.url ||
        data.data?.video_url ||
        data.metadata?.url;

      if (!videoUrl) {

        throw new Error(
          `Vidéo terminée mais URL absente: ${JSON.stringify(data).slice(0, 1800)}`
        );
      }

      console.log(
  `[VIDEO TIMING] Polling ${videoId}: ${((Date.now() - pollStartedAt) / 1000).toFixed(1)}s, ${pollAttempts} requêtes`
);

return videoUrl;
    }

    // ========================================================
    // FAILED
    // ========================================================

    if (
      [
        'failed',
        'error',
        'cancelled',
        'canceled'
      ].includes(status)
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

    await sleep(
      getAdaptivePollDelay(
        data.progress != null
          ? Number(data.progress)
          : null      )
    );
  }

  throw new Error(
    `Délai maximal dépassé pour video_id=${videoId}`
  );
}

// __CSP_AUTO_CONTINUITY_V2__
// Native scene-to-scene continuity. This logic is intentionally inside
// server.js so deployment cannot silently skip a runtime source patch.
async function extractLastFrameAsDataUrl(videoUrl, jobId, sceneNumber) {
  if (!videoUrl) {
    throw new Error('Continuité: URL vidéo absente pour la scène ' + sceneNumber);
  }

  const tempId = crypto.randomUUID();
  const inputPath = path.join(DATA_DIR, '__csp_video_' + tempId + '.mp4');
  const outputPath = path.join(DATA_DIR, '__csp_frame_' + tempId + '.jpg');
  const persistentPath = path.join(
    CONTINUITY_FRAME_DIR,
    String(jobId) + '_scene_' + String(sceneNumber) + '.jpg'
  );

  try {
    console.log('[CONTINUITY] Téléchargement scène ' + sceneNumber + ' pour capturer sa dernière image…');
    const response = await fetchWithTimeout(
      videoUrl,
      {},
      AGNES_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error('Téléchargement vidéo HTTP ' + response.status);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error('Vidéo terminée mais vide');
    }
    fs.writeFileSync(inputPath, buffer);

    const { default: ffmpegInstaller } = await import('@ffmpeg-installer/ffmpeg');
    const { spawn } = await import('child_process');

    async function runLastFrameExtraction(seekFromEnd) {
      try { fs.unlinkSync(outputPath); } catch (_) {}

      await new Promise((resolve, reject) => {
        const child = spawn(
          ffmpegInstaller.path,
          [
            '-y',
            '-sseof', String(seekFromEnd),
            '-i', inputPath,
            '-frames:v', '1',
            '-q:v', '2',
            '-f', 'image2',
            outputPath
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );

        let stderr = '';
        child.stderr.on('data', chunk => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error('FFmpeg dernière frame failed (' + code + '): ' + stderr.slice(-1200)));
            return;
          }
          if (!fs.existsSync(outputPath)) {
            reject(new Error('FFmpeg terminé sans produire l’image finale (seek=' + seekFromEnd + ')'));
            return;
          }
          resolve();
        });
      });
    }

    // Some MP4s have a timestamp/index layout for which a seek of only
    // 10 ms before EOF exits successfully but produces no image. Retry
    // farther from EOF so continuity never fails on a valid completed video.
    try {
      await runLastFrameExtraction('-1');
    } catch (firstError) {
      console.warn('[CONTINUITY] Première extraction finale échouée, nouvelle tentative plus large…', firstError.message);
      await runLastFrameExtraction('-2');
    }

    const jpg = fs.readFileSync(outputPath);
    if (!jpg.length) {
      throw new Error('Image finale vide');
    }

    fs.writeFileSync(persistentPath, jpg);

    const hash = crypto
      .createHash('sha256')
      .update(jpg)
      .digest('hex');

    console.log(
      '[CONTINUITY] Scène ' + sceneNumber +
      ' → dernière image capturée (' +
      Math.round(jpg.length / 1024) +
      ' KB, sha256=' + hash.slice(0, 16) + '…)'
    );

    return {
      dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64'),
      filePath: persistentPath,
      hash
    };
  } finally {
    for (const file of [inputPath, outputPath]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

function restorePersistedContinuityFrame(scene) {
  if (scene?.last_frame) return scene.last_frame;

  const filePath = String(scene?.last_frame_path || '');
  if (!filePath) return null;

  try {
    const jpg = fs.readFileSync(filePath);
    if (!jpg.length) return null;
    return 'data:image/jpeg;base64,' + jpg.toString('base64');
  } catch (_) {
    return null;
  }
}

// ============================================================
// JOB WORKER
// ============================================================

const activeJobIds = new Set();

function updateJob(job) {
  job.updatedAt = Date.now();
  saveJobs(jobs);
}

async function processJob(job) {
  try {

    job.status =
      'processing';

    updateJob(job);

    for (
      const scene of job.scenes
    ) {

      if (
        scene.status === 'done'
      ) {
        continue;
      }

      if (
        job.status ===
        'cancelled'
      ) {
        break;
      }

      scene.status =
        'processing';

      updateJob(job);

      try {

        const sceneIndex = job.scenes.indexOf(scene);
        const sceneNumber = sceneIndex + 1;
        const previousScene = sceneIndex > 0 ? job.scenes[sceneIndex - 1] : null;

        if (!scene.videoId) {
          let sceneInput;

          if (sceneIndex === 0) {
            sceneInput = {
              ...scene,
              sequenceIndex: 0,
              mode: 'reference',
              visualBible: job.visualBible || '',
              images: scene.images?.length
                ? scene.images
                : (job.referenceImage ? [job.referenceImage] : [])
            };

            console.log(
              '[CONTINUITY] Scène 1 → image maître originale utilisée comme référence de départ.'
            );
          } else {
            const continuityImage = restorePersistedContinuityFrame(previousScene);

            if (!continuityImage) {
              throw new Error(
                'Continuité impossible : la dernière image de la scène ' +
                sceneIndex +
                ' est introuvable. Aucun fallback vers l’image maître n’est autorisé.'
              );
            }

            sceneInput = {
              ...scene,
              sequenceIndex: sceneIndex,
              mode: 'reference',
              visualBible: job.visualBible || '',
              images: [continuityImage],
              first_frame: null,
              last_frame: null
            };

            console.log(
              '[CONTINUITY] Scène ' + sceneNumber +
              ' → UNIQUE référence = dernière image de la scène ' +
              sceneIndex +
              ', longueur=' +
              Math.round(continuityImage.length / 1024) +
              ' KB.'
            );
          }

          const created = await createVideoTask(sceneInput, { get: () => '' });
          scene.videoId = created.videoId;
          scene.model = created.model;
          scene.sequenceIndex = sceneIndex;
          scene.referenceType = sceneIndex === 0 ? 'initial' : 'previous-last-frame';
          updateJob(job);
        }

        scene.videoUrl =
          await pollVideo(
            scene.videoId,
            {
              get: () => ''
            },
            scene.model || MODEL
          );

        if (job.status === 'cancelled') {
          scene.videoUrl = null;
          updateJob(job);
          break;
        }

        if (sceneIndex < job.scenes.length - 1) {
          try {
            const captured = await extractLastFrameAsDataUrl(
              scene.videoUrl,
              job.id,
              sceneNumber
            );
            scene.last_frame = captured.dataUrl;
            scene.last_frame_path = captured.filePath;
            scene.last_frame_hash = captured.hash;
            scene.referenceReadyForNext = true;
            console.log(
              '[CONTINUITY] Scène ' + sceneNumber +
              ' → frame finale prête pour la scène ' + (sceneNumber + 1) + '.'
            );
          } catch (frameError) {
            throw new Error(
              'Continuité scène ' + sceneNumber +
              ' : impossible d’extraire la dernière image — ' +
              String(frameError?.message || frameError)
            );
          }
        }

        scene.status =
          'done';

        scene.error =
          null;

        job.error =
          null;

      } catch (error) {

        const message =
          String(
            error?.message ||
            error
          );

        scene.status =
          'failed';

        scene.error =
          message;

        const sceneIndex =
          job.scenes.indexOf(
            scene
          ) + 1;

        job.error =
          `Scène ${sceneIndex}: ${message}`;

        console.error(
          '[JOB FAILED]',
          job.id,
          job.error
        );

        job.status =
          'failed';

        updateJob(job);

        break;
      }

      updateJob(job);
    }

    if (job.status === 'cancelled') {
      // Preserve the cancellation request even if the current remote poll ended.
    } else if (
      job.scenes.length > 0 &&
      job.scenes.every(
        s =>
          s.status === 'done'
      )
    ) {

      job.status =
        'completed';

    } else if (
      job.status !==
      'failed' &&
      job.status !==
      'cancelled'
    ) {

      job.status =
        'queued';
    }

    updateJob(job);

  } catch (error) {

    console.error('[WORKER ERROR]', job.id, error);

  } finally {
    activeJobIds.delete(job.id);
  }
}

function processJobs() {
  const apiKeyToUse = process.env.AGNES_API_KEY || AGNES_API_KEY;
  if (!apiKeyToUse) return;

  const availableSlots = MAX_CONCURRENT_JOBS - activeJobIds.size;
  if (availableSlots <= 0) return;

  const candidates = Object.values(jobs)
    .filter(job =>
      (job.status === 'queued' || job.status === 'processing') &&
      !activeJobIds.has(job.id)
    )
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  for (const job of candidates.slice(0, availableSlots)) {
    activeJobIds.add(job.id);
    void processJob(job);
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  (req, res) => {

    return res.json({

      ok:
        true,

      workerConfigured:
        Boolean(
          process.env.AGNES_API_KEY ||
          AGNES_API_KEY
        ),

      model:
        MODEL,

      legacyModel:
        LEGACY_MODEL,

      apiBase:
        API_BASE
    });
  }
);

// ============================================================
// CREATE JOB
// ============================================================

app.post(
  '/api/jobs',
  requirePrivateAuth,
  (req, res) => {

    const key =
      getApiKeyForRequest(req) ||
      process.env.AGNES_API_KEY ||
      AGNES_API_KEY;

    if (!key) {

      return res.status(503).json({

        error:
          'AGNES_API_KEY non configurée sur le serveur.'
      });
    }

    const { scenes, referenceImage, visualBible } = req.body || {};

    if (
      !Array.isArray(scenes) ||
      !scenes.length
    ) {

      return res.status(400).json({

        error:
          'Aucune scène.'
      });
    }

    if (
      scenes.length > 20
    ) {

      return res.status(400).json({

        error:
          'Trop de scènes.'
      });
    }

    const suppliedReference =
      typeof referenceImage === 'string' && referenceImage.startsWith('data:image/')
        ? referenceImage
        : null;
    const legacyReference =
      !suppliedReference && scenes.length > 0 &&
      typeof scenes[0]?.images?.[0] === 'string'
        ? scenes[0].images[0]
        : null;
    const sharedReference = suppliedReference || legacyReference;
    const hasSharedLegacyReference = Boolean(sharedReference) && scenes.every(scene =>
      Array.isArray(scene.images) && scene.images.length === 1 && scene.images[0] === sharedReference
    );

    const id =
      crypto.randomUUID();

    jobs[id] = {

      id,

      status:
        'queued',

      createdAt:
        Date.now(),

      updatedAt:
        Date.now(),

      error:
        null,

      referenceImage: sharedReference,

      // Permanent project-level identity/environment anchor reused by every scene.
      visualBible:
        typeof visualBible === 'string'
          ? visualBible.trim().slice(0, 12000)
          : '',

      scenes:
        scenes.map(
          (s, i) => {

            const legacyImage =
              s.image ||
              null;

            const images =
              Array.isArray(
                s.images
              ) &&
              s.images.length
                ? s.images
                    .filter(Boolean)
                    .slice(0, 5)
                : (
                    legacyImage
                      ? [
                          legacyImage
                        ]
                      : []
                  );

            const seconds =
              Number(
                s.seconds
              ) ||
              (
                Number(s.frames)
                  ? Number(s.frames) /
                    FRAME_RATE
                  : 8
              );

            return {

              prompt:
                String(
                  s.prompt || ''
                ),

              sequenceIndex:
                i,

              mode:
                s.mode ||
                (
                  images.length
                    ? 'reference'
                    : 'text'
                ),

              seconds:
                seconds,

              size:
                s.size ||
                '720P',

              aspect_ratio:
                s.aspect_ratio ||
                '9:16',

              first_frame:
                s.first_frame ||
                null,

              last_frame:
                s.last_frame ||
                null,

              images:
                hasSharedLegacyReference || suppliedReference
                  ? []
                  : images,

              frames:
                Number(
                  s.frames
                ) ||
                Math.round(
                  seconds *
                  FRAME_RATE
                ),

              status:
                'pending',

              videoId:
                null,

              videoUrl:
                null,

              model:
                null,

              error:
                null
            };
          }
        )
    };

    // Send the 202 immediately. Persistence is debounced and compact.
    res.setHeader('X-Job-Id', id);
    res.setHeader('Cache-Control', 'no-store');

    const jobResponseStartedAt = Date.now();

    res
      .status(202)
      .json({
        id:
          id,
        status:
          'queued'
      });

    console.log(
      `[JOB CREATE TIMING] Réponse 202 envoyée en ${((Date.now() - jobResponseStartedAt) / 1000).toFixed(3)}s`
    );

    saveJobs(jobs);

    setImmediate(() => {
      try {
        processJobs();
      } catch (error) {
        console.error(
          '[WORKER LAUNCH ERROR]',
          error
        );
      }
    });
  }
);

// ============================================================
// JOB STATUS
// ============================================================

app.get(
  '/api/jobs/:id',
  requirePrivateAuth,
  (req, res) => {

    const job =
      jobs[
        req.params.id
      ];

    if (!job) {

      return res.status(404).json({

        error:
          'Job introuvable'
      });
    }

    return res.json(
      safeJob(job)
    );
  }
);

// ============================================================
// CANCEL JOB
// ============================================================

app.post(
  '/api/jobs/:id/cancel',
  requirePrivateAuth,
  (req, res) => {

    const job =
      jobs[
        req.params.id
      ];

    if (!job) {

      return res.status(404).json({

        error:
          'Job introuvable'
      });
    }

    if (
      job.status ===
      'completed'
    ) {

      return res.status(409).json({

        error:
          'Déjà terminé'
      });
    }

    job.status =
      'cancelled';

    job.updatedAt =
      Date.now();

    saveJobs(
      jobs
    );

    return res.json(
      safeJob(job)
    );
  }
);

// ============================================================
// APPLICATION
// ============================================================

app.get(
  '/',
  (req, res) => {

    return res.sendFile(
      path.join(
        process.cwd(),
        'public',
        'index.html'
      )
    );
  }
);

app.get(
  /^(?!\/api\/).*/,
  (req, res) => {

    return res.sendFile(
      path.join(
        process.cwd(),
        'public',
        'index.html'
      )
    );
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Cinema V9.4 listening on :${PORT}`
    );

    console.log(
      'AUTH CONFIG: APP_PASSWORD=',
      Boolean(
        process.env.APP_PASSWORD
      ),
      'AUTH_SECRET=',
      Boolean(
        process.env.AUTH_SECRET
      )
    );

    console.log(
      'AGNES API KEY:',
      Boolean(
        process.env.AGNES_API_KEY
      )
    );

    console.log(
      'AGNES MODEL:',
      MODEL
    );

    console.log(
      'PRIVATE WEB GATE: ENABLED'
    );
  }
);

// ============================================================
// BACKGROUND WORKER
// ============================================================

setInterval(
  processJobs,
  3000
);

processJobs();