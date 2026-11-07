import { createServer } from 'node:http';
import { AI_PROTOCOL_VERSION, AIRequestSchema, AIResultSchema, type AIScores } from './protocol.js';

export type Classifier = (image: Blob, labels: string[]) => Promise<AIScores>;

/** Injectable loader keeps HTTP contract tests independent of model downloads. */
export function createAIWorker(model: string, load: () => Promise<Classifier>) {
  let classifier: Classifier | null = null;
  let state: 'loading' | 'ready' | 'error' = 'loading';
  let error: string | null = null;
  let busy = false;
  const ready = load()
    .then((value) => {
      classifier = value;
      state = 'ready';
    })
    .catch(() => {
      state = 'error';
      error = 'Model could not be loaded; check the worker logs and restart to retry';
    });
  const server = createServer(async (req, res) => {
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/v1/health') {
      json(state === 'ready' ? 200 : 503, { version: AI_PROTOCOL_VERSION, model, state, error });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/classify') {
      json(404, { error: 'Not found' });
      return;
    }
    if (!classifier) {
      json(503, { error: 'Model is not ready' });
      return;
    }
    if (busy) {
      json(429, { error: 'Worker is busy' });
      return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      json(415, { error: 'Expected JSON' });
      return;
    }
    // Only one body/inference at a time, with a bounded body and no input URLs.
    busy = true;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 9_000_000) {
          json(413, { error: 'Image too large' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const parsed = AIRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success) {
        json(400, { error: 'Invalid v1 classification request' });
        return;
      }
      const input = parsed.data;
      if (input.model !== model) {
        json(409, { error: 'Model mismatch' });
        return;
      }
      const image = new Blob([new Uint8Array(Buffer.from(input.image, 'base64'))], {
        type: 'image/jpeg',
      });
      const scores = await classifier(image, input.labels);
      json(200, AIResultSchema.parse({ version: AI_PROTOCOL_VERSION, scores }));
    } catch (err) {
      json(err instanceof SyntaxError ? 400 : 500, { error: 'Classification failed' });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, ready };
}
