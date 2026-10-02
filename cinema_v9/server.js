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

const MODEL =
  'agnes-video-2.5-flash';

const LEGACY_MODEL =
  'agnes-video-2.5-flash';

const FRAME_RATE = 24;

const DATA_DIR =
  path.join(
    process.cwd(),
    'data'
  );

const JOBS_FILE =
  path.join(
    DATA_DIR,
    'jobs.json'
  );

const MAX_VIDEO_SECONDS = 12;
const AGNES_REQUEST_TIMEOUT_MS = 45000;
const AGNES_POLL_TIMEOUT_MS = 30000;
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Math.min(4, Number(process.env.JOB_CONCURRENCY) || 2)
);
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED_JOBS = 100;

fs.mkdirSync(
  DATA_DIR,
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

    return JSON.parse(
      fs.readFileSync(
        JOBS_FILE,
        'utf8'
      )
    );

  } catch (_) {

    return {};
  }
}

function pruneJobs(jobsData) {
  const now = Date.now();
  const entries = Object.entries(jobsData)
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));

  for (const [id, job] of entries.slice(MAX_STORED_JOBS)) {
    if (['completed', 'failed', 'cancelled'].includes(job.status)) delete jobsData[id];
  }

  for (const [id, job] of Object.entries(jobsData)) {
    if (
      ['completed', 'failed', 'cancelled'].includes(job.status) &&
      now - (job.updatedAt || job.createdAt || 0) > JOB_RETENTION_MS
    ) delete jobsData[id];
  }
}

function saveJobs(jobsData) {
  pruneJobs(jobsData);
  const tempFile = `${JOBS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(jobsData, null, 2));
  fs.renameSync(tempFile, JOBS_FILE);
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

function buildRealismPrompt(basePrompt, mode, imageCount) {
  const prompt = String(basePrompt || '').trim();

  const continuity = [
    'LIVE-ACTION PHOTOREALISM ONLY.',
    'The result must look like real footage captured by a professional cinema camera, with physically plausible anatomy, motion, lighting, materials, reflections and depth.',
    'Use natural human facial proportions, realistic skin pores and texture, individual hair strands, believable eyes, teeth and hands, realistic fabric and body weight.',
    'Preserve identity continuously: the same face, apparent age, hairstyle, body proportions, skin tone, clothing, accessories and distinctive physical traits must remain unchanged throughout the shot.',
    'Preserve scene continuity: the same location, objects, weather, time of day, lighting direction, color temperature and spatial relationships must remain coherent.',
    'Motion must be subtle and physically plausible: natural walking, breathing, blinking, eye focus, hand gestures, cloth and hair movement. No robotic or rubbery motion.',
    'Camera work must feel physically captured: restrained handheld, dolly, slider or tripod movement, realistic shutter/motion blur, natural depth of field and lens perspective.',
    'Do not stylize or redesign the subject. No anime, cartoon, illustration, painterly look, plastic skin, doll-like face, game-engine look, CGI render or obvious AI artifacts.',
    'No face morphing, identity drift, age change, body-shape change, duplicate people, extra fingers, malformed hands, warped objects or background instability.',
    'No subtitles, captions, logos, watermarks or generated on-screen writing.',
    'Keep the original story action and dialogue from the user prompt. Do not add new characters or events unless explicitly requested.'
  ].join(' ');

  let referenceContext = '';
  if (mode === 'reference' && imageCount > 0) {
    const refs = Array.from({ length: imageCount }, (_, i) => '<Picture ' + (i + 1) + '>').join(', ');
    referenceContext =
      'Reference images are the identity and visual-continuity anchors. Treat these references as authoritative for the character and environment. Match them closely and keep them consistent from beginning to end. Reference material: ' +
      refs + '.';
  } else if (mode === 'keyframe') {
    referenceContext =
      'The supplied keyframe image(s) are authoritative continuity anchors. Preserve the exact identity, wardrobe, environment and lighting shown in them; changes must be limited to the requested motion and camera movement.';
  }

  const languageRule =
    'If speech is present, use natural spoken French only, with accurate French lip synchronization.';

  return [continuity, referenceContext, languageRule, prompt]
    .filter(Boolean)
    .join('\n\n');
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

  const sourcePrompt =
    String(
      scene.prompt || ''
    ).trim();

  if (!sourcePrompt) {

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
  // PRIMARY BODY
  // ==========================================================

  const enhancedPrompt =
    buildRealismPrompt(
      sourcePrompt,
      mode,
      images.length
    );

  const primaryBody = {

    model:
      MODEL,

    prompt:
      enhancedPrompt,

    mode:
      mode,

    seconds:
      String(seconds),

    size:
      scene.size ||
      '720P',

    aspect_ratio:
      scene.aspect_ratio ||
      '9:16',

    n:
      1
  };

  if (
    mode === 'keyframe'
  ) {

    if (firstFrame) {
      primaryBody.first_frame =
        firstFrame;
    }

    if (lastFrame) {
      primaryBody.last_frame =
        lastFrame;
    }

    if (
      !primaryBody.first_frame &&
      !primaryBody.last_frame
    ) {

      throw new Error(
        'Mode keyframe sélectionné sans image de départ ou de fin'
      );
    }
  }

  if (
    mode === 'reference'
  ) {

    if (!images.length) {

      throw new Error(
        'Mode reference sélectionné sans image de référence'
      );
    }

    primaryBody.images =
      images;
  }

  // ==========================================================
  // MODERN AGNES 2.5 REQUEST
  // ==========================================================
  //
  // The 2.5 Flash API uses the modern video schema:
  // model + prompt + mode + seconds + size + aspect_ratio
  // plus reference/keyframe media when requested.
  // Do not send legacy v2.0 frame-count parameters.
  // ==========================================================

  console.log(
    '[AGNES PROFILE]',
    JSON.stringify({
      model: MODEL,
      mode,
      seconds,
      size: scene.size || '720P',
      aspect_ratio: scene.aspect_ratio || '9:16',
      referenceImages: images.length,
      keyframeStart: Boolean(firstFrame),
      keyframeEnd: Boolean(lastFrame),
      realismProfile: 'live-action-photorealistic-v1'
    })
  );

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
          body.mode ||
          'legacy',

        seconds:
          body.seconds ||
          null,

        num_frames:
          body.num_frames ||
          null,

        size:
          body.size ||
          null,

        aspect_ratio:
          body.aspect_ratio ||
          null,

        imageCount:
          Array.isArray(
            body.images
          )
            ? body.images.length
            : (
                body.image
                  ? 1
                  : 0
              )
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
const queueRetryDelays = [
  15000,
  30000,
  45000
];
const rateLimitRetryDelays = [
  120000
];

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
  `Limite API gratuite atteinte après plusieurs tentatives.`
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
      `Agnes est actuellement saturé après plusieurs tentatives. ${primaryMessage}`
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

  // ==========================================================
  // LEGACY FALLBACK
  // ==========================================================
  //
  // Only for compatibility/schema/model errors.
  // ==========================================================

  const status =
    extractHttpStatus(
      primaryMessage
    );

  const canFallback =
    [
      400,
      404,
      405,
      415,
      422,
      500,
      501,
      502
    ].includes(status) ||
    /model|schema|parameter|seconds|duration|frames|invalid/i
      .test(
        primaryMessage
      );

  if (!canFallback) {

    throw primaryError;
  }

  const validFrames =
    getValidLegacyFrames(
      requestedFrames
    );

  const legacyBody = {

    model:
      LEGACY_MODEL,

    prompt:
      prompt,

    num_frames:
      validFrames,

    frame_rate:
      FRAME_RATE
  };

  // Legacy API accepts one image.
  if (firstFrame) {

    legacyBody.image =
      firstFrame;

  } else if (images.length) {

    legacyBody.image =
      images[0];
  }

  console.warn(
    '[VIDEO FALLBACK] primary rejected:',
    primaryMessage
  );

  console.log(
    '[VIDEO FALLBACK] requestedFrames=',
    requestedFrames,
    'validFrames=',
    validFrames
  );

  try {

    return await postVideo(
      legacyBody,
      'legacy-v2.0-fallback'
    );

  } catch (fallbackError) {

    const fallbackMessage =
      String(
        fallbackError?.message ||
        fallbackError
      );

    if (
      isRateLimitError(
        fallbackMessage
      ) ||
      extractHttpStatus(
        fallbackMessage
      ) === 429
    ) {

      throw new Error(
        `Limite API gratuite atteinte, veuillez réessayer plus tard.`
      );
    }

    throw new Error(
      `Création vidéo échouée. Primaire: ${primaryMessage.slice(0, 700)} | Fallback: ${fallbackMessage.slice(0, 700)}`
    );
  }
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

  const maxAttempts =
    180;

  const pollDelay =
    20000;

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
    console.warn(
        `[VIDEO POLL] Agnes répond ${response.status}. Nouvelle tentative dans 30 secondes.`
    );

    await sleep(30000);
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
      pollDelay
    );
  }

  throw new Error(
    `Délai maximal dépassé pour video_id=${videoId}`
  );
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

        if (!scene.videoId) {
          const sceneInput = {
            ...scene,
            images: scene.images?.length ? scene.images : (job.referenceImage ? [job.referenceImage] : [])
          };
          const created = await createVideoTask(sceneInput, { get: () => '' });
          scene.videoId = created.videoId;
          scene.model = created.model;
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

    const { scenes, referenceImage } = req.body || {};

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

      scenes:
        scenes.map(
          s => {

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

    saveJobs(
      jobs
    );

    // Launch immediately.
    setImmediate(() => {
    processJobs().catch(error => {
        console.error('[WORKER LAUNCH ERROR]', error);
    });
});

    return res
      .status(202)
      .json({

        id:
          id,

        status:
          'queued'
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
