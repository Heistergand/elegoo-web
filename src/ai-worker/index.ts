import { env, pipeline } from '@huggingface/transformers';
import { createAIWorker, type Classifier } from './server.js';

const model = process.env.AI_LOCAL_MODEL || 'Xenova/siglip-base-patch16-224';
env.useBrowserCache = false;
env.allowLocalModels = true;
env.cacheDir = process.env.AI_MODEL_CACHE || '/models';
const { server } = createAIWorker(model, async () => {
  console.info(`Loading CPU model ${model}`);
  try {
    const classifier = await pipeline('zero-shot-image-classification', model, {
      dtype: 'q8',
      device: 'cpu',
    });
    console.info('AI worker ready');
    return classifier as unknown as Classifier;
  } catch (error) {
    console.error('Model initialization failed:', error);
    throw error;
  }
});
server.listen(8090, '0.0.0.0', () => console.info('AI worker listening on :8090 (internal only)'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
