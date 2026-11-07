import {
  AIHealthSchema,
  AI_PROTOCOL_VERSION,
  AIResultSchema,
  type AIScores,
} from '../ai-worker/protocol.js';

export class AIWorkerClient {
  state: 'loading' | 'ready' | 'error' | 'unavailable' = 'unavailable';
  error: string | null = null;

  constructor(
    private url: string,
    private model: string,
    private timeoutMs = 120_000,
  ) {}

  async refresh(): Promise<void> {
    try {
      const response = await fetch(new URL('/v1/health', this.url), {
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
      const health = AIHealthSchema.parse(await response.json());
      if (health.model !== this.model)
        throw new Error('AI_LOCAL_MODEL must match the worker model');
      this.state = health.state;
      this.error = health.error;
    } catch (error) {
      this.state = 'unavailable';
      this.error = `AI worker unavailable: ${(error as Error).message.slice(0, 160)}`;
    }
  }

  async classify(image: Buffer, labels: string[]): Promise<AIScores> {
    try {
      const response = await fetch(new URL('/v1/classify', this.url), {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: AI_PROTOCOL_VERSION,
          model: this.model,
          image: image.toString('base64'),
          labels,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`AI worker returned HTTP ${response.status}`);
      const { scores } = AIResultSchema.parse(await response.json());
      if (
        scores.length !== labels.length ||
        new Set(scores.map((r) => r.label)).size !== labels.length ||
        scores.some((r) => !labels.includes(r.label))
      ) {
        throw new Error('AI worker returned mismatched labels');
      }
      this.state = 'ready';
      this.error = null;
      return scores.sort((a, b) => b.score - a.score);
    } catch (error) {
      this.state = 'unavailable';
      this.error = (error as Error).message.slice(0, 200);
      throw error;
    }
  }
}
