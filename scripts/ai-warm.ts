/**
 * Pre-downloads the vision-model weights so an offline demo works first time.
 *
 * WHY: the first `analyze` call on a cold machine downloads ~149 MB. At a hackathon
 * venue with unreliable wifi that is a failure waiting to happen. Run this once while
 * you still have internet:
 *
 *     npm run ai:warm
 *
 * It performs a REAL load and a REAL inference on a generated test image, so a green
 * result means more than "the file exists" — it means the model actually runs here.
 */
import { LocalClipAnalyzer } from '@campus/domain';
import { loadConfig, loadDotEnv } from '@campus/db';

loadDotEnv();

const config = loadConfig({ ...process.env, AI_PROVIDER: 'local-clip' });

async function main() {
  console.log(`Loading ${config.aiModel} into ${config.aiCacheDir} ...`);
  const started = Date.now();

  // A 512x384 image built in memory: no fixture files, no evidence storage involved.
  const width = 512;
  const height = 384;
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = (i / 3) % 255;
    pixels[i + 1] = (i / 7) % 255;
    pixels[i + 2] = 128;
  }
  const { RawImage } = await import('@huggingface/transformers');
  const image = new RawImage(pixels, width, height, 3);

  const analyzer = new LocalClipAnalyzer({
    provider: 'local-clip',
    model: config.aiModel,
    cacheDir: config.aiCacheDir,
    confidenceThreshold: config.aiConfidenceThreshold,
    ambiguityMargin: config.aiAmbiguityMargin,
    timeoutMs: config.aiTimeoutMs,
    maxAttempts: 1,
    allowRemoteDownload: config.aiAllowRemoteDownload,
    loadEvidence: async () => Buffer.alloc(0),
    // Bypass storage: the image is already decoded, so no evidence file is needed.
    decodeImage: async () => ({ handle: image, width, height }),
  });

  await analyzer.warmup();

  const result = await analyzer.analyze({
    reportId: '00000000-0000-4000-8000-000000000000',
    evidenceRef: 'warmup://generated',
    mimeType: 'image/jpeg',
    selectedCategorySlug: 'water-leakage',
    blockId: 'warmup',
    spotId: 'warmup',
    latitude: null,
    longitude: null,
    submittedAt: new Date(),
    candidateCategories: [
      { id: '00000000-0000-4000-8000-000000000001', slug: 'water-leakage', name: 'Water Leakage', description: 'Leaking pipes, taps, tanks, or seepage' },
    ],
  });

  console.log(`\nModel loaded and ran in ${Date.now() - started} ms.`);
  console.log(`Provider : ${result.provider}`);
  console.log(`Model    : ${result.model} (${result.modelVersion})`);
  console.log(`Status   : ${result.status}`);
  console.log(`Ranking  : ${JSON.stringify(analyzer.lastDiagnostics?.ranked)}`);
  console.log('\nCache is warm. With AI_ALLOW_REMOTE_DOWNLOAD=false the model still runs offline.');
}

main().catch((error) => {
  console.error('\nWarm-up FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
