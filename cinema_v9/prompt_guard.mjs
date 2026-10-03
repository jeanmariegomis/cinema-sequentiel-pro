// Global prompt guard for Agnes Video V2.0.
// Runs before bootstrap/server.js and only rewrites POST /videos JSON prompts.
// It does not touch authentication, job polling, downloads, progress, or continuity state.

const ORIGINAL_FETCH = globalThis.fetch;
const GUARD_MARKER = '[CSP GLOBAL CHARACTER/ACTION/AUDIO/CAMERA/STATE GUARD V7]';

function buildGuard(prompt) {
  const text = String(prompt || '');
  const lower = text.toLowerCase();
  const isFirstScene = /\bscene\s*1\s+of\s+\d+\b/i.test(text);
  const rules = [
    GUARD_MARKER,
    'CHARACTER COUNT LOCK: preserve exactly the characters explicitly described by the scene prompt and supplied reference image. Do not create, duplicate, clone, mirror, split, merge, replace, or transform any character.',
    'IDENTITY LOCK: every existing character keeps the same face, age, body proportions, hairstyle, clothing, colors, accessories, and distinctive features throughout the shot and from the preceding scene.',
    'HAIR IDENTITY LOCK: hair is a fixed identity feature. Preserve exact hairline, parting, length, curl/wave pattern, curl size, density, volume, silhouette, color, highlights, texture and distinctive loose strands. Never shorten, lengthen, straighten, tighten curls, change the part, change the hairline or recolor the hair unless explicitly requested.',
    'PERMANENT SUBJECT LOCK: once a person or animal is established by the reference image and visual bible, keep that same subject present and coherent unless the scene explicitly instructs an exit, departure or intentional removal.',
    'PERSONALITY LOCK: preserve the established temperament, emotional baseline, social attitude, gaze behavior, energy level, posture, gesture style and natural mannerisms. Do not invent a smile, flirtatious attitude, excitement, surprise, anger, theatrical reaction, or personality change unless the scene explicitly causes it.',
    'EMOTIONAL CONTINUITY LOCK: expressions and emotional states must evolve gradually and have a visible narrative cause. Do not reset the character into a different emotional state merely to make the shot visually attractive.',
    'OBJECT IDENTITY LOCK: every important prop must remain the same physical object across adjacent moments. Preserve its shape, color, material, markings, size, orientation and relationship to the subject. Do not make a bowl, cup, spoon, jug, pan or other prop disappear, reappear, duplicate or become a different object.',
    'OBJECT STATE LOCK: preserve the current state of every important prop and substance. Keep fill level, contents, color, texture and consistency stable unless the AUTHORITATIVE SCENE PROMPT explicitly describes and visibly causes a change.',
    'MATERIAL STATE LOCK: do not transform milk, water, juice, oil, batter, dough, sauce, powder, food or other substances into another material simply because the next action is plausible. No spontaneous liquid-to-paste, liquid-to-dough, dough-to-liquid or color/texture change.',
    'ACTION SUBJECT LOCK: only the named subject performs the named action. Keep hands, tools, objects, targets, trajectories, and physical contact consistent with the written instruction.',
    'STATE CAUSALITY LOCK: an object or material may change state only through a continuous visible action that is explicitly described by the scene. Never perform hidden off-screen preparation or invent an unseen transformation.',
    'NO UNREQUESTED EVENTS: do not add new characters, actions, objects, accidents, reactions, transformations, story events, or dialogue merely because they are visually plausible.',
    'CAMERA SINGLE-TAKE LOCK: create one continuous physical camera take for the whole scene unless the scene prompt explicitly requests a cut. Never use an internal jump cut, instant angle replacement, teleporting viewpoint, mirrored viewpoint, snap zoom, sudden focal-length jump, or instant recomposition.',
    'CAMERA MOTION LOCK: camera pans, tilts, dollies, tracks and zooms must accelerate and decelerate progressively. When the prompt requests a later angle, reach it through a physically continuous camera movement instead of replacing the current shot with a new composition.',
    'CAMERA STATE LOCK: preserve the established camera orientation, horizon, height, scale, lens relationship and subject framing until a deliberate smooth camera movement begins. Never rotate or roll the camera abruptly.',
    'CAMERA NO-AUTO-DRAMA LOCK: do not invent dramatic camera rolls, dutch angles, sudden push-ins, whip pans, orbit jumps, overhead switches, or perspective flips unless explicitly requested by the scene prompt.',
    'DIALOGUE LOCK: no character speaks, lip-syncs, mouths words, or produces dialogue unless dialogue is explicitly written in the scene prompt. Never invent conversations or voices.',
    'AUDIO POLICY: keep scripted dialogue and natural diegetic sounds that belong to the visible action. Background music, instrumental score, soundtrack, song, singing, and non-diegetic musical beds are OFF by default.',
    'MUSIC BAN BY DEFAULT: do not add, invent, continue, restart, fade in, or maintain background music unless the AUTHORITATIVE SCENE PROMPT explicitly requests music. Silence is preferable to invented music.',
    'AUDIO SPEECH CONTINUITY: preserve the established character voice identity across scenes when dialogue is scripted. Do not introduce unrelated voices, narration, singing, or vocal improvisation.',
    'SCENE AUDIO LOCK: no unrequested narrator, singing, human voice, animal voice, or sound effect that creates a new story event. Natural room, cooking, movement and animal sounds may remain when they are visibly/physically justified.'
  ];

  if (isFirstScene) {
    rules.push(
      'FIRST SCENE OPENING CAMERA MASTER LOCK — ABSOLUTE: the supplied master reference image is the authoritative visual and camera starting state. Treat its exact visible composition as frame 0. Do not reinterpret the reference as a new shot.',
      'FIRST SCENE OPENING HOLD — 2.5 SECONDS: for the first 2.5 seconds, keep the camera effectively locked to the reference composition. No roll, tilt, pan, orbit, dolly, truck, crane, whip-pan, zoom, focal-length change, camera-height change, viewpoint switch, mirror, crop jump, perspective flip, close-up-to-wide transition, wide-to-close transition, or subject-scale change.',
      'FIRST SCENE NO-BASCULE: the camera horizon must remain level and the verticals must remain stable during the entire 2.5-second opening hold. Absolutely no sudden camera bascule/dutch angle, diagonal horizon, rotational snap or sideways camera flip.',
      'FIRST SCENE NO-RECOMPOSITION: do not replace the opening framing with a new cinematic composition. The woman, bowl, cat and other visible reference subjects must remain in the same spatial relationship during the opening hold.',
      'FIRST SCENE NO-CUT SUBSTITUTE: do not simulate a cut by rapidly moving the camera, changing focal length, changing depth-of-field, changing perspective, or jumping subject scale. The opening must remain one physical camera state.',
      'FIRST SCENE TRANSITION AFTER HOLD: only after 2.5 seconds may a requested camera movement begin, and it must start from the exact reference composition with gradual acceleration. If the prompt does not explicitly request a camera move, keep the camera stable for the entire scene.',
      'FIRST SCENE CAMERA CAUSALITY: cinematic variety is never a reason to invent a camera movement. Follow the written camera instruction only after the opening hold and only as a physically continuous movement.'
    );
  }

  const animalPattern = /\b(chat|chats|cat|cats|chien|chiens|dog|dogs|animal|animaux|oiseau|oiseaux|bird|birds|pigeon|pigeons|cheval|chevaux|horse|horses)\b/i;
  if (animalPattern.test(lower)) {
    rules.push(
      'ANIMAL LOCK: each animal remains a non-human animal with the exact appearance, size, species, fur/feathers, face, and natural anatomy established by the reference. Never duplicate or clone the animal.',
      'ANIMAL SPEECH LOCK: animals never speak like humans, never perform human lip-sync, and never receive human dialogue or a human voice unless the scene explicitly requests an anthropomorphic speaking animal.',
      'ANIMAL AUDIO LOCK: do not give an animal a human voice, narration, singing, or dialogue. Normal animal sounds are allowed only when explicitly requested or naturally appropriate.'
    );
  }

  return rules.join('\n');
}

globalThis.fetch = async function guardedFetch(input, init = {}) {
  let url = '';
  try { url = typeof input === 'string' ? input : String(input?.url || ''); } catch (_) {}
  const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
  if (method === 'POST' && /\/videos(?:\?|$)/i.test(url)) {
    try {
      const headers = new Headers(init?.headers || (typeof input !== 'string' ? input?.headers : undefined));
      const contentType = String(headers.get('content-type') || '').toLowerCase();
      const rawBody = init?.body;
      if (rawBody && (!contentType || contentType.includes('application/json'))) {
        const bodyText = typeof rawBody === 'string' ? rawBody : await new Response(rawBody).text();
        const body = JSON.parse(bodyText);
        const originalPrompt = String(body.prompt || '').trim();
        if (originalPrompt && !originalPrompt.includes(GUARD_MARKER)) {
          body.prompt = `${buildGuard(originalPrompt)}\n\nSCENE PROMPT (AUTHORITATIVE):\n${originalPrompt}`;
          const nextInit = { ...init, headers, body: JSON.stringify(body) };
          console.log('[PROMPT GUARD] Camera/personality/audio/state constraints injected for Agnes scene.');
          return ORIGINAL_FETCH.call(this, input, nextInit);
        }
      }
    } catch (error) {
      console.error('[PROMPT GUARD] Prompt guard skipped:', error?.message || error);
    }
  }
  return ORIGINAL_FETCH.call(this, input, init);
};

console.log('[PROMPT GUARD] Global character/animal/action/audio/camera/state guard V7 loaded.');
