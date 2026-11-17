import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createAIWorker, type Classifier } from '../../ai-worker/server.js';
import { AIWorkerClient } from '../ai-worker-client.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function worker(load: () => Promise<Classifier>) {
  const instance = createAIWorker('test-model', load);
  servers.push(instance.server);
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return { ...instance, url: `http://127.0.0.1:${address.port}` };
}

describe('optional AI worker HTTP contract', () => {
  it('passes image bytes and custom labels and sorts validated raw scores', async () => {
    const w = await worker(async () => async (image, labels) => {
      expect(Buffer.from(await image.arrayBuffer()).toString()).toBe('synthetic-image');
      expect(labels).toEqual(['normal', 'failure']);
      return [
        { label: 'normal', score: 0.2 },
        { label: 'failure', score: 0.8 },
      ];
    });
    await w.ready;
    const client = new AIWorkerClient(w.url, 'test-model');
    await client.refresh();
    expect(client.state).toBe('ready');
    expect(await client.classify(Buffer.from('synthetic-image'), ['normal', 'failure'])).toEqual([
      { label: 'failure', score: 0.8 },
      { label: 'normal', score: 0.2 },
    ]);
  });

  it('reports loading and recovers when model initialization completes', async () => {
    let resolveLoad!: (value: Classifier) => void;
    const w = await worker(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const client = new AIWorkerClient(w.url, 'test-model');
    await client.refresh();
    expect(client.state).toBe('loading');
    await expect(client.classify(Buffer.from('test'), ['normal'])).rejects.toThrow('503');
    resolveLoad(async () => [{ label: 'normal', score: 1 }]);
    await w.ready;
    await client.refresh();
    expect(client.state).toBe('ready');
    expect(client.error).toBeNull();
  });

  it('reports a failed model without crashing the health server', async () => {
    const w = await worker(async () => {
      throw new Error('offline');
    });
    await w.ready;
    const client = new AIWorkerClient(w.url, 'test-model');
    await client.refresh();
    expect(client.state).toBe('error');
    expect(client.error).toContain('Model could not be loaded');
  });

  it('rejects model mismatch and mismatched classification labels', async () => {
    const w = await worker(async () => async () => [{ label: 'wrong', score: 1 }]);
    await w.ready;
    const client = new AIWorkerClient(w.url, 'other-model');
    await client.refresh();
    expect(client.error).toContain('AI_LOCAL_MODEL');
    await expect(client.classify(Buffer.from('test'), ['normal'])).rejects.toThrow('409');
    await expect(
      new AIWorkerClient(w.url, 'test-model').classify(Buffer.from('test'), ['normal']),
    ).rejects.toThrow('mismatched labels');
  });

  it('bounds inference waiting and refuses concurrent inference', async () => {
    let finish!: (value: Array<{ label: string; score: number }>) => void;
    const w = await worker(
      async () => () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await w.ready;
    const client = new AIWorkerClient(w.url, 'test-model', 100);
    await expect(client.classify(Buffer.from('test'), ['normal'])).rejects.toThrow();
    expect(client.state).toBe('unavailable');
    await expect(client.classify(Buffer.from('test'), ['normal'])).rejects.toThrow('429');
    finish([{ label: 'normal', score: 1 }]);
  });

  it('rejects incompatible versions and URL inputs before inference', async () => {
    const w = await worker(async () => async () => {
      throw new Error('Must not run');
    });
    await w.ready;
    for (const input of [
      { version: 2, image: 'dGVzdA==' },
      { version: 1, image: 'http://example.invalid/image.jpg' },
    ]) {
      const response = await fetch(`${w.url}/v1/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, model: 'test-model', labels: ['normal'] }),
      });
      expect(response.status).toBe(400);
    }
  });
});
