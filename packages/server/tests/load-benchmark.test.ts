import { describe, it, expect } from 'vitest';
import { runWebSocketBenchmark } from '../../../tests/load/websocket-load.js';

describe('Spectator WebSocket Load Benchmark Suite (WBS-3.4)', () => {
  it('streams binary frames to 500 concurrent spectators with zero packet drop and p99 < 80ms', async () => {
    const metrics = await runWebSocketBenchmark({
      clientCount: 500,
      ticksCount: 20,
    });

    expect(metrics.totalClients).toBe(500);
    expect(metrics.totalTicks).toBe(20);
    expect(metrics.actualDeliveries).toBe(metrics.expectedDeliveries);
    expect(metrics.packetDropRate).toBe(0.0);
    expect(metrics.averageFrameBytes).toBeLessThanOrEqual(200);
    expect(metrics.p50Ms).toBeLessThanOrEqual(25);
    expect(metrics.p95Ms).toBeLessThanOrEqual(50);
    expect(metrics.p99Ms).toBeLessThanOrEqual(80);
  }, 30000);
});
