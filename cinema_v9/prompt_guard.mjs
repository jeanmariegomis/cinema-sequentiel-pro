// Global prompt guard for Agnes Video V2.0.
// Runs before bootstrap/server.js and only rewrites POST /videos JSON prompts.
// It does not touch authentication, job polling, downloads, progress, or continuity state.

const ORIGINAL_FETCH = globalThis.fetch;
const GUARD_MARKER = '[CSP GLOBAL CHARACTER/ACTION/AUDIO/CAMERA GUARD V4]';

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
    'ACTION SUBJECT LOCK: only the named subject performs the named action. Keep hands, tools, objects, targets, trajectories, and physical contact consistent with the written instruction.',
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
      'FIRST SCENE OPENING CAMERA LOCK: the supplied master reference image is the authoritative starting camera state, not merely an identity reference. The first generated moment must preserve its visible camera orientation, horizon level, camera height, perspective, subject scale and overall composition.',
      'FIRST SCENE FIRST-SECOND LOCK: during approximately the first second, do not roll, rotate, whip-pan, snap-zoom, jump to a new lens, jump to a new height, orbit to another side, mirror the image, or replace the opening composition. Start from the reference state and introduce only subtle continuous motion.',
      'FIRST SCENE CAMERA TRANSITION: if the scene prompt requests another angle, transition there gradually from the reference camera state. Never satisfy the request by cutting or abruptly replacing the opening viewpoint.',
      'FIRST SCENE HORIZON LOCK: keep the horizon and verticals stable at the opening. No sudden dutch angle or camera tilt unless the prompt explicitly requests a gradual tilt.'
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
          console.log('[PROMPT GUARD] Camera/personality/audio constraints injected for Agnes scene.');
          return ORIGINAL_FETCH.call(this, input, nextInit);
        }
      }
    } catch (error) {
      console.error('[PROMPT GUARD] Prompt guard skipped:', error?.message || error);
    }
  }
  return ORIGINAL_FETCH.call(this, input, init);
};

console.log('[PROMPT GUARD] Global character/animal/action/audio/camera guard V4 loaded.');
