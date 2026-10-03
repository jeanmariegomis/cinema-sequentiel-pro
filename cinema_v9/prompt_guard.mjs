// Global prompt guard for Agnes Video V2.0.
// Runs before bootstrap/server.js and only rewrites POST /videos JSON prompts.
// It does not touch authentication, job polling, downloads, progress, or continuity state.

const ORIGINAL_FETCH = globalThis.fetch;
const GUARD_MARKER = '[CSP GLOBAL CHARACTER/ACTION/AUDIO GUARD V3]';

function buildGuard(prompt) {
  const text = String(prompt || '');
  const lower = text.toLowerCase();
  const rules = [
    GUARD_MARKER,
    'CHARACTER COUNT LOCK: preserve exactly the characters explicitly described by the scene prompt and supplied reference image. Do not create, duplicate, clone, mirror, split, merge, replace, or transform any character.',
    'IDENTITY LOCK: every existing character keeps the same face, age, body proportions, hairstyle, clothing, colors, accessories, and distinctive features throughout the shot and from the preceding scene.',
    'HAIR IDENTITY LOCK: hair is a fixed identity feature. Preserve exact hairline, parting, length, curl/wave pattern, curl size, density, volume, silhouette, color, highlights, texture and distinctive loose strands. Never shorten, lengthen, straighten, tighten curls, change the part, change the hairline or recolor the hair unless explicitly requested.',
    'PERMANENT SUBJECT LOCK: once a person or animal is established by the reference image and visual bible, keep that same subject present and coherent unless the scene explicitly instructs an exit, departure or intentional removal.',
    'ACTION SUBJECT LOCK: only the named subject performs the named action. Keep hands, tools, objects, targets, trajectories, and physical contact consistent with the written instruction.',
    'DIALOGUE LOCK: no character speaks, lip-syncs, mouths words, or produces dialogue unless dialogue is explicitly written in the scene prompt. Never invent conversations or voices.',
    'NO UNREQUESTED EVENTS: do not add new characters, actions, objects, accidents, reactions, transformations, story events, or dialogue merely because they are visually plausible.',
    'AUDIO PRESENCE LOCK: unless the scene explicitly requests silence/no sound, ALWAYS include an audible cinematic sound bed or instrumental music. Never leave a scene randomly silent.',
    'AUDIO CONTINUITY LOCK: preserve the established project sound character across scenes. Keep a related mood, instrumentation family, production character and stable perceived volume. Do not switch to an unrelated musical genre or randomly drop the audio.',
    'MUSIC CONSISTENCY LOCK: when music is present or requested, keep the same broad musical identity, tempo family, instrumentation family and sonic character across the sequence unless the prompt explicitly requests a deliberate change.',
    'SCENE AUDIO LOCK: no abrupt start/stop, no random silence, no invented narrator, no singing or vocals unless explicitly scripted, and no unrequested sound effects that create new story events.',
    'DO NOT USE AUDIO TO INVENT STORY EVENTS: sound must not introduce an unseen speaking character, conversation, narrator, laugh, animal voice, or other event that is absent from the visual/story instructions.'
  ];
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
          console.log('[PROMPT GUARD] Character/action/audio constraints injected for Agnes scene.');
          return ORIGINAL_FETCH.call(this, input, nextInit);
        }
      }
    } catch (error) {
      console.error('[PROMPT GUARD] Prompt guard skipped:', error?.message || error);
    }
  }
  return ORIGINAL_FETCH.call(this, input, init);
};

console.log('[PROMPT GUARD] Global character/animal/action/audio guard V3 loaded.');
