import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { AIMonitor } from '../ai-monitor.js';
import { loadConfig } from '../config.js';
import type { StateStore } from '../state-store.js';
import { getSnapshot } from '../rest-api.js';

vi.mock('../rest-api.js', () => ({ getSnapshot: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AI monitor with optional local inference', () => {
  it('uses the external VLM without contacting a local worker', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PRINTER_IP', '192.0.2.99');
    const store = Object.assign(new EventEmitter(), {
      status: { machine_status: { status: 1, sub_status: 2075 } },
      zones: { current: 'print_area' },
    });
    const config = {
      ...loadConfig(),
      aiEnabled: true,
      aiLocalEnabled: false,
      aiVlmEnabled: true,
      aiVlmProvider: 'ollama' as const,
      aiVlmBaseUrl: 'http://vlm.invalid',
      dataDir: '/nonexistent-test-dir',
    };
    const frame = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } })
      .jpeg()
      .toBuffer();
    vi.mocked(getSnapshot).mockResolvedValue(frame);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              status: 'ok',
              confidence: 0.9,
              issues: [],
              description: 'Synthetic test',
            }),
          },
        }),
      ),
    );
    const monitor = new AIMonitor(store as unknown as StateStore, config);
    try {
      await monitor.start();
      expect(fetchMock).not.toHaveBeenCalled();
      store.emit('print_event', { type: 'print_started' });
      await vi.advanceTimersByTimeAsync(10_000);
      // sharp performs native async work outside the fake timer queue.
      await vi.waitFor(() => expect(monitor.getHistory()).toHaveLength(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('http://vlm.invalid/api/chat');
      expect(monitor.getLatest().vlm.description).toBe('Synthetic test');
    } finally {
      monitor.stop();
    }
  });

  it('reports worker connection failure while the monitor remains running', async () => {
    vi.stubEnv('PRINTER_IP', '192.0.2.99');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('worker offline'));
    const store = Object.assign(new EventEmitter(), { status: { machine_status: { status: 1 } } });
    const monitor = new AIMonitor(store as unknown as StateStore, {
      ...loadConfig(),
      aiEnabled: true,
      aiLocalEnabled: true,
      dataDir: '/nonexistent-test-dir',
    });
    try {
      await monitor.start();
      await vi.waitFor(() => expect(monitor.getConfigSummary().localState).toBe('unavailable'));
      expect(fetchMock).toHaveBeenCalled();
      expect(monitor.isRunning).toBe(true);
      expect(monitor.getConfigSummary().localError).toContain('worker offline');
    } finally {
      monitor.stop();
    }
  });
});
