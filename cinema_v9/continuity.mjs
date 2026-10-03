import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

if (!source.includes('// __CSP_AUTO_CONTINUITY_V2__')) {
  let out = source;

  const helperMarker = '// ============================================================\n// JOB WORKER\n// ============================================================';
  const helper = String.raw`// __CSP_AUTO_CONTINUITY_V2__
// Automatic scene-to-scene continuity.
// Scene 1 is NEVER altered. Every later scene receives the final
// frame extracted from the immediately previous completed scene.
async function extractLastFrameAsDataUrl(videoUrl) {
  const tempId = crypto.randomUUID();
  const inputPath = path.join(DATA_DIR, '__csp_video_' + tempId + '.mp4');
  const outputPath = path.join(DATA_DIR, '__csp_frame_' + tempId + '.jpg');

  try {
    console.log('[CONTINUITY] Téléchargement de la scène terminée pour capturer sa dernière image…');
    const response = await fetchWithTimeout(videoUrl, {}, AGNES_REQUEST_TIMEOUT_MS);
    if (!response.ok) throw new Error('Téléchargement vidéo HTTP ' + response.status);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(inputPath, buffer);

    const { default: ffmpegInstaller } = await import('@ffmpeg-installer/ffmpeg');
    const { spawn } = await import('child_process');

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegInstaller.path, [
        '-y',
        '-sseof', '-0.01',
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error('FFmpeg dernière frame failed (' + code + '): ' + stderr.slice(-1200)));
      });
    });

    const jpg = fs.readFileSync(outputPath);
    if (!jpg.length) throw new Error('Image finale vide');

    const dataUrl = 'data:image/jpeg;base64,' + jpg.toString('base64');
    console.log('[CONTINUITY] Dernière image capturée: ' + Math.round(jpg.length / 1024) + ' KB');
    return dataUrl;
  } finally {
    for (const file of [inputPath, outputPath]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

`;

  if (!out.includes(helperMarker)) throw new Error('CONTINUITY: job worker marker not found');
  out = out.replace(helperMarker, helper + helperMarker);

  const doneNeedle = `        scene.status =
          'done';`;
  const doneReplacement = `        // __CSP_AUTO_CONTINUITY_CAPTURE__
        // IMPORTANT: Scene 1 is untouched. Once any scene completes,
        // capture its final image in memory for the next scene.
        if (scene.videoUrl && !scene.last_frame) {
          try {
            scene.last_frame = await extractLastFrameAsDataUrl(scene.videoUrl);
            const completedSceneNumber = job.scenes.indexOf(scene) + 1;
            console.log('[CONTINUITY] Scène ' + completedSceneNumber + ': dernière image prête comme référence de la scène suivante.');
          } catch (frameError) {
            console.warn('[CONTINUITY] Impossible de capturer la dernière image:', frameError?.message || frameError);
          }
        }

        scene.status =
          'done';`;
  if (!out.includes(doneNeedle)) throw new Error('CONTINUITY: scene done marker not found');
  out = out.replace(doneNeedle, doneReplacement);

  const inputNeedle = `          const sceneInput = {
            ...scene,
            images: scene.images?.length
              ? scene.images
              : (job.referenceImage ? [job.referenceImage] : [])
          };`;
  const inputReplacement = `          // __CSP_AUTO_CONTINUITY_INPUT__
          const sceneIndex = job.scenes.indexOf(scene);
          const previousScene = sceneIndex > 0 ? job.scenes[sceneIndex - 1] : null;
          const continuityImage = previousScene?.last_frame || null;

          // Scene 1: preserve the exact existing input and generation behavior.
          // Scene 2+: replace the reference with ONLY the previous scene's final image.
          const sceneInput = sceneIndex === 0
            ? {
                ...scene,
                images: scene.images?.length
                  ? scene.images
                  : (job.referenceImage ? [job.referenceImage] : [])
              }
            : {
                ...scene,
                mode: continuityImage ? 'reference' : scene.mode,
                images: continuityImage
                  ? [continuityImage]
                  : (scene.images?.length
                      ? scene.images
                      : (job.referenceImage ? [job.referenceImage] : [])),
                first_frame: null,
                last_frame: null
              };

          console.log(
            '[CONTINUITY] Scène ' + (sceneIndex + 1) +
            (sceneIndex === 0
              ? ': référence originale conservée.'
              : (continuityImage
                  ? ': dernière image de la scène précédente utilisée comme UNIQUE référence.'
                  : ': ATTENTION aucune dernière image disponible, fallback conservé.'))
          );`;
  if (!out.includes(inputNeedle)) throw new Error('CONTINUITY: scene input marker not found');
  out = out.replace(inputNeedle, inputReplacement);

  fs.writeFileSync(serverPath, out, 'utf8');
  console.log('[CONTINUITY] server.js patched: scene 1 preserved, later scenes chained from previous final frame.');
} else {
  console.log('[CONTINUITY] server.js already contains automatic continuity V2 patch.');
}

await import(pathToFileURL(path.join(root, 'bootstrap.mjs')).href);
