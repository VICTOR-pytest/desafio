import { JsonLogger } from './json-logger';
import { MetricsRegistry } from './metrics';

describe('MetricsRegistry', () => {
  it('acumula contadores por rótulo e renderiza no formato Prometheus', () => {
    const metrics = new MetricsRegistry();

    metrics.increment('wager_transactions_total', { status: 'PROCESSED', type: 'BET' });
    metrics.increment('wager_transactions_total', { status: 'PROCESSED', type: 'BET' }, 2);
    metrics.increment('wager_transactions_total', { status: 'REJECTED', type: 'BET' });

    expect(metrics.counter('wager_transactions_total', { status: 'PROCESSED', type: 'BET' })).toBe(3);
    expect(metrics.render()).toContain('wager_transactions_total{status="PROCESSED",type="BET"} 3');
    expect(metrics.render()).toContain('wager_transactions_total{status="REJECTED",type="BET"} 1');
  });

  it('renderiza histogramas com buckets cumulativos, soma e contagem', () => {
    const metrics = new MetricsRegistry();

    metrics.observe('latency', 0.02);
    metrics.observe('latency', 0.3);
    const text = metrics.render();

    expect(text).toContain('latency_bucket{le="0.025"} 1');
    expect(text).toContain('latency_bucket{le="0.5"} 2');
    expect(text).toContain('latency_bucket{le="+Inf"} 2');
    expect(text).toContain('latency_count 2');
    expect(text).toContain('latency_sum 0.32');
  });

  it('renderiza gauges', () => {
    const metrics = new MetricsRegistry();

    metrics.setGauge('outbox_lag_seconds', 12.5);

    expect(metrics.render()).toContain('outbox_lag_seconds 12.5');
  });

  it('escapa aspas nos valores dos rótulos', () => {
    const metrics = new MetricsRegistry();

    metrics.increment('x', { reason: 'a"b' });

    expect(metrics.render()).toContain('x{reason="a\\"b"} 1');
  });
});

describe('JsonLogger', () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line), () => new Date('2026-01-02T03:04:05.000Z'));
    return { lines, logger };
  };

  it('emite uma linha JSON com nível, mensagem e campos de correlação', () => {
    const { lines, logger } = capture();

    logger.info('processed', { correlationId: 'c1', walletId: 'w1', skipped: undefined });

    expect(JSON.parse(lines[0])).toEqual({
      timestamp: '2026-01-02T03:04:05.000Z',
      level: 'info',
      message: 'processed',
      correlationId: 'c1',
      walletId: 'w1',
    });
  });

  it('oculta campos sensíveis', () => {
    const { lines, logger } = capture();

    logger.error('boom', { password: 'x', apiKey: 'y', authorization: 'z', providerId: 'p' });

    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'error',
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      providerId: 'p',
    });
  });
});
