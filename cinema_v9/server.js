import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.AGNES_API_BASE || 'https://api.agnes.com';
const app = express();

// ============================================================
// AUTHENTIFICATION PRIVÉE
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
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const payload = String(exp);

  const secret = process.env.AUTH_SECRET || '';

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

  const parts = token.split('.');

  if (parts.length !== 2) {
    return false;
  }

  const [exp, sig] = parts;

  if (!exp || !sig) {
    return false;
  }

  if (Number(exp) < Date.now()) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', process.env.AUTH_SECRET)
    .update(exp)
    .digest('hex');

  return timingSafeEqualHex(sig, expected);
}

function requirePrivateAuth(req, res, next) {
  const token = getCookie(req, 'csp_auth');

  if (validAuthToken(token)) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: 'AUTH_REQUIRED'
  });
}

// ============================================================
// PAGE DE CONNEXION
// ============================================================

const LOGIN_HTML = `<!doctype html>
<html lang="fr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Connexion privée</title>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

body {
  min-height: 100vh;
  display: grid;
  place-items: center;

  background:
    radial-gradient(
      circle at top,
      #1c2748 0%,
      #0b1020 55%,
      #050812 100%
    );

  color: #ffffff;

  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.card {

  width: min(92vw, 430px);

  padding: 30px;

  border-radius: 20px;

  background:
    rgba(21, 28, 50, 0.96);

  border:
    1px solid rgba(255,255,255,0.08);

  box-shadow:
    0 25px 80px rgba(0,0,0,.45);

}

h1 {

  margin:
    0 0 10px;

  font-size: 26px;

}

p {

  color: #aeb7cc;

  line-height: 1.5;

}

label {

  display: block;

  margin-top: 20px;

  margin-bottom: 7px;

  font-size: 14px;

  color: #cbd3e6;

}

input {

  width: 100%;

  padding: 15px;

  border-radius: 11px;

  border:
    1px solid #39445f;

  background:
    #0d1426;

  color:
    #ffffff;

  outline:
    none;

  font-size:
    16px;

}

input:focus {

  border-color:
    #7d8cff;

}

button {

  width: 100%;

  margin-top: 16px;

  padding: 15px;

  border: 0;

  border-radius: 11px;

  background:
    #ffffff;

  color:
    #111827;

  font-size:
    16px;

  font-weight:
    700;

  cursor:
    pointer;

}

button:disabled {

  opacity:
    .6;

  cursor:
    wait;

}

#error {

  min-height:
    24px;

  margin-top:
    14px;

  color:
    #ff8c8c;

  font-size:
    14px;

}

.loading {

  display:
    none;

  margin-top:
    15px;

  text-align:
    center;

  color:
    #aeb7cc;

}

</style>

</head>

<body>

<main class="card">

<h1>🔐 Connexion privée</h1>

<p>
Entrez le mot de passe pour accéder à
<strong>Cinema Séquentiel Pro</strong>.
</p>

<form id="login">

<label for="password">
Mot de passe
</label>

<input
  id="password"
  type="password"
  autocomplete="current-password"
  placeholder="Mot de passe"
  required
>

<button
  id="submitButton"
  type="submit"
>
Se connecter
</button>

<div
  id="loading"
  class="loading"
>
Vérification...
</div>

<div
  id="error"
></div>

</form>

</main>

<script>

const form =
  document.getElementById('login');

const password =
  document.getElementById('password');

const button =
  document.getElementById('submitButton');

const error =
  document.getElementById('error');

const loading =
  document.getElementById('loading');

form.addEventListener(
  'submit',
  async function(event) {

    event.preventDefault();

    error.textContent = '';

    const value =
      password.value;

    if (!value) {

      error.textContent =
        'Entrez votre mot de passe.';

      return;
    }

    button.disabled = true;

    loading.style.display =
      'block';

    try {

      const response =
        await fetch(
          '/api/auth/login',
          {
            method: 'POST',

            credentials: 'same-origin',

            headers: {
              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({
              password: value
            })
          }
        );

      const data =
        await response
          .json()
          .catch(() => ({}));

      if (!response.ok) {

        if (
          data.error ===
          'INVALID_PASSWORD'
        ) {

          error.textContent =
            'Mot de passe incorrect.';

        } else if (
          data.error ===
          'AUTH_NOT_CONFIGURED'
        ) {

          error.textContent =
            'Authentification non configurée sur le serveur.';

        } else {

          error.textContent =
            data.error ||
            'Erreur de connexion.';
        }

        button.disabled = false;

        loading.style.display =
          'none';

        return;
      }

      window.location.replace('/');

    } catch (err) {

      console.error(err);

      error.textContent =
        'Serveur inaccessible.';

      button.disabled = false;

      loading.style.display =
        'none';
    }

  }
);

</script>

</body>

</html>`;

// ============================================================
// ROUTES AUTHENTIFICATION
// ============================================================

function setupPrivateAuthRoutes() {

  app.post(
    '/api/auth/login',
    express.json(),
    (req, res) => {

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

      // --------------------------------------------------------
      // APP_PASSWORD
      // --------------------------------------------------------

      if (plainPassword !== '') {

        valid =
          timingSafeEqualHex(
            hashPassword(password),
            hashPassword(plainPassword)
          );

        console.log(
          'Authentication method: APP_PASSWORD'
        );

      }

      // --------------------------------------------------------
      // APP_PASSWORD_SHA256
      // --------------------------------------------------------

      else if (expectedHash !== '') {

        valid =
          timingSafeEqualHex(
            hashPassword(password),
            expectedHash
              .trim()
              .toLowerCase()
          );

        console.log(
          'Authentication method: APP_PASSWORD_SHA256'
        );

      }

      else {

        console.log(
          'Authentication method: NONE'
        );

      }

      console.log(
        'Password comparison result:',
        valid
      );

      console.log(
        '======================'
      );

      // --------------------------------------------------------
      // Configuration manquante
      // --------------------------------------------------------

      if (
        (!plainPassword &&
          !expectedHash) ||
        !authSecretConfigured
      ) {

        return res.status(503).json({
          ok: false,
          error: 'AUTH_NOT_CONFIGURED'
        });

      }

      // --------------------------------------------------------
      // Mot de passe incorrect
      // --------------------------------------------------------

      if (!valid) {

        return res.status(401).json({
          ok: false,
          error: 'INVALID_PASSWORD'
        });

      }

      // --------------------------------------------------------
      // Création session
      // --------------------------------------------------------

      const token =
        makeAuthToken();

      res.setHeader(
        'Set-Cookie',

        `csp_auth=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`
      );

      console.log(
        'Authentication successful'
      );

      return res.json({
        ok: true
      });

    }
  );

  // ----------------------------------------------------------
  // LOGOUT
  // ----------------------------------------------------------

  app.post(
    '/api/auth/logout',
    (req, res) => {

      res.setHeader(
        'Set-Cookie',
        'csp_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
      );

      res.json({
        ok: true
      });

    }
  );

  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  app.get(
    '/api/auth/status',
    (req, res) => {

      res.json({
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
// AGNES
// ============================================================

function getAgnesKey(req) {

  const fromClient =
    req.get(
      'X-Agnes-API-Key'
    );

  return (
    fromClient &&
    fromClient.trim()
  ) || '';

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

  } catch {}

  return (
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY ||
    ''
  );

}

const MODEL_VIDEO =
  'agnes-video-v2.0';

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

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);

// ============================================================
// EXPRESS
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

    res
      .type('html')
      .send(LOGIN_HTML);

  }
);

// ============================================================
// AUTH ROUTES
// ============================================================

setupPrivateAuthRoutes();

// ============================================================
// PRIVATE WEB GATE
// ============================================================
//
// IMPORTANT :
// Cette protection arrive AVANT express.static().
// Donc index.html ne peut pas être chargé sans session.
//

app.use(
  (req, res, next) => {

    // Page de connexion publique
    if (
      req.path ===
      '/login.html'
    ) {

      return next();

    }

    // API d'authentification publique
    if (
      req.path.startsWith(
        '/api/auth/'
      )
    ) {

      return next();

    }

    // Session valide
    if (
      validAuthToken(
        getCookie(
          req,
          'csp_auth'
        )
      )
    ) {

      return next();

    }

    // API privée
    if (
      req.path.startsWith(
        '/api/'
      )
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            'AUTH_REQUIRED'
        });

    }

    // Toute page privée
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
// JOBS
// ============================================================

function loadJobs() {

  try {

    return JSON.parse(
      fs.readFileSync(
        JOBS_FILE,
        'utf8'
      )
    );

  } catch {

    return {};

  }

}

function saveJobs(jobs) {

  fs.writeFileSync(
    JOBS_FILE,
    JSON.stringify(
      jobs,
      null,
      2
    )
  );

}

let jobs =
  loadJobs();

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

    total:
      job.scenes.length,

    completed:
      job.scenes.filter(
        s =>
          s.status ===
          'done'
      ).length,

    failed:
      job.scenes.filter(
        s =>
          s.status ===
          'failed'
      ).length,

    scenes:
      job.scenes.map(
        (s, i) => ({
          index:
            i,

          status:
            s.status,

          videoUrl:
            s.videoUrl ||
            null,

          error:
            s.error ||
            null
        })
      )

  };

}

async function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}

// ============================================================
// CREATE VIDEO
// ============================================================

async function createVideoTask(
  scene,
  req
) {

  const apiKeyToUse =
    getApiKeyForRequest(req) ||
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  const body = {

    model:
      MODEL_VIDEO,

    prompt:
      scene.prompt,

    num_frames:
      scene.frames,

    frame_rate:
      FRAME_RATE

  };

  if (scene.image) {

    body.image =
      scene.image;

  }

  const res =
    await fetch(
      API_BASE +
        '/videos',
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/json',

          'Authorization':
            'Bearer ' +
            apiKeyToUse

        },

        body:
          JSON.stringify(
            body
          )

      }
    );

  const txt =
    await res.text();

  if (!res.ok) {

    throw new Error(
      'Creation HTTP ' +
      res.status +
      ' — ' +
      txt.slice(
        0,
        300
      )
    );

  }

  const data =
    JSON.parse(txt);

  const id =
    data.video_id ||
    data.id ||
    data.task_id;

  if (!id) {

    throw new Error(
      "L'API n'a pas retourné de video_id"
    );

  }

  return id;

}

// ============================================================
// POLLING VIDEO
// ============================================================

async function pollVideo(
  videoId,
  req
) {

  const apiKeyToUse =
    getApiKeyForRequest(req) ||
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  for (
    let attempt = 0;
    attempt < 120;
    attempt++
  ) {

    const res =
      await fetch(
        API_BASE +
          '/videos/status?video_id=' +
          encodeURIComponent(
            videoId
          ) +
          '&model_name=' +
          encodeURIComponent(
            MODEL_VIDEO
          ),
        {

          headers: {

            'Authorization':
              'Bearer ' +
              apiKeyToUse

          }

        }
      );

    const txt =
      await res.text();

    if (!res.ok) {

      throw new Error(
        'Polling HTTP ' +
        res.status +
        ' — ' +
        txt.slice(
          0,
          250
        )
      );

    }

    const d =
      JSON.parse(txt);

    const status =
      d.status ||
      'unknown';

    console.log(
      'Video status:',
      status
    );

    if (
      [
        'completed',
        'succeeded',
        'done'
      ].includes(status)
    ) {

      const url =
        (
          d.metadata &&
          d.metadata.url
        ) ||
        d.url ||
        (
          d.output &&
          d.output.url
        );

      if (!url) {

        throw new Error(
          'Vidéo terminée mais URL absente'
        );

      }

      return url;

    }

    if (
      [
        'failed',
        'error',
        'cancelled'
      ].includes(status)
    ) {

      throw new Error(
        'Échec moteur vidéo: ' +
        status
      );

    }

    await sleep(
      5000
    );

  }

  throw new Error(
    'Délai maximal dépassé'
  );

}

// ============================================================
// WORKER
// ============================================================

let workerBusy =
  false;

async function processJobs() {

  if (workerBusy) {
    return;
  }

  const apiKeyToUse =
    process.env.AGNES_API_KEY ||
    AGNES_API_KEY;

  if (!apiKeyToUse) {
    return;
  }

  const job =
    Object.values(
      jobs
    ).find(
      j =>
        j.status ===
          'queued' ||
        j.status ===
          'processing'
    );

  if (!job) {
    return;
  }

  workerBusy =
    true;

  try {

    job.status =
      'processing';

    job.updatedAt =
      Date.now();

    saveJobs(jobs);

    for (
      const scene of
      job.scenes
    ) {

      if (
        scene.status ===
        'done'
      ) {

        continue;

      }

      scene.status =
        'processing';

      job.updatedAt =
        Date.now();

      saveJobs(jobs);

      try {

        const videoId =
          await createVideoTask(
            scene,
            {
              get: () => ''
            }
          );

        scene.videoId =
          videoId;

        job.updatedAt =
          Date.now();

        saveJobs(jobs);

        scene.videoUrl =
          await pollVideo(
            videoId,
            {
              get: () => ''
            }
          );

        scene.status =
          'done';

        scene.error =
          null;

      } catch (e) {

        scene.status =
          'failed';

        scene.error =
          e.message;

        job.status =
          'failed';

        job.updatedAt =
          Date.now();

        saveJobs(jobs);

        break;

      }

      job.updatedAt =
        Date.now();

      saveJobs(jobs);

    }

    if (
      job.scenes.every(
        s =>
          s.status ===
          'done'
      )
    ) {

      job.status =
        'completed';

    } else if (
      job.status !==
      'failed'
    ) {

      job.status =
        'queued';

    }

    job.updatedAt =
      Date.now();

    saveJobs(jobs);

  } finally {

    workerBusy =
      false;

  }

}

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      ok:
        true,

      workerConfigured:
        Boolean(
          process.env.AGNES_API_KEY ||
          AGNES_API_KEY
        ),

      authentication:
        true

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

      return res
        .status(503)
        .json({
          error:
            'AGNES_API_KEY non configurée sur le serveur.'
        });

    }

    const {
      scenes
    } =
      req.body || {};

    if (
      !Array.isArray(scenes) ||
      !scenes.length
    ) {

      return res
        .status(400)
        .json({
          error:
            'Aucune scène.'
        });

    }

    if (
      scenes.length >
      20
    ) {

      return res
        .status(400)
        .json({
          error:
            'Trop de scènes.'
        });

    }

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

      scenes:
        scenes.map(
          s => ({

            prompt:
              String(
                s.prompt ||
                ''
              ),

            image:
              s.image ||
              null,

            frames:
              Number(
                s.frames
              ) || 480,

            status:
              'pending',

            videoUrl:
              null,

            error:
              null

          })
        )

    };

    saveJobs(
      jobs
    );

    processJobs();

    res
      .status(202)
      .json({
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

      return res
        .status(404)
        .json({
          error:
            'Job introuvable'
        });

    }

    res.json(
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

      return res
        .status(404)
        .json({
          error:
            'Job introuvable'
        });

    }

    if (
      job.status ===
      'completed'
    ) {

      return res
        .status(409)
        .json({
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

    res.json(
      safeJob(job)
    );

  }
);

// ============================================================
// APPLICATION
// ============================================================
//
// Ces routes ne sont atteintes qu'après le PRIVATE WEB GATE.
//

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
  /^(?!\/api\/|\/login\.html$).*/,
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
      `Cinema V13 listening on :${PORT}`
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
      'PRIVATE WEB GATE: ENABLED'
    );

  }
);

setInterval(
  processJobs,
  3000
);

processJobs();
