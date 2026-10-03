// Global prompt guard for Agnes Video V2.0.
// Runs before bootstrap/server.js and only rewrites POST /videos JSON prompts.
// It does not touch authentication, job polling, downloads, progress, or continuity state.

const ORIGINAL_FETCH = globalThis.fetch;
const GUARD_MARKER = '[CSP GLOBAL CHARACTER/ACTION/AUDIO GUARD V2]';

function buildGuard(prompt) {
  const text = String(prompt || '');
  const lower = text.toLowerCase();
  const rules = [
    GUARD_MARKER,
    'CHARACTER COUNT LOCK: preserve exactly the characters explicitly described by the scene prompt and supplied reference image. Do not create, duplicate, clone, mirror, split, merge, replace, or transform any character.',
    'IDENTITY LOCK: every existing character keeps the same face, age, body proportions, hairstyle, clothing, colors, accessories, and distinctive features throughout the shot and from the preceding scene.',
    'ACTION SUBJECT LOCK: only the named subject performs the named action. Keep hands, tools, objects, targets, trajectories, and physical contact consistent with the written instruction.',
    'DIALOGUE LOCK: no character speaks, lip-syncs, mouths words, or produces dialogue unless dialogue is explicitly written in the scene prompt. Never invent conversations or voices.',
    'NO UNREQUESTED EVENTS: do not add new characters, actions, objects, accidents, reactions, transformations, story events, or dialogue merely because they are visually plausible.',
    'AUDIO CONTINUITY LOCK: preserve the requested sound design across the scene. Do not invent music, dialogue, narration, singing, voices, or sound effects that are not requested.',
    'MUSIC CONSISTENCY LOCK: when the prompt specifies music or a musical atmosphere, keep the same musical style, mood, instrumentation, tempo, and sonic identity throughout the shot. Do not switch to an unrelated musical genre.',
    'SCENE AUDIO LOCK: if the prompt or project audio direction requests music/ambience, keep an audible, coherent background track or ambience throughout the entire scene unless a deliberate fade or silence is explicitly requested. Do not randomly start or stop music.',
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

console.log('[PROMPT GUARD] Global character/animal/action/audio guard loaded.');
