import { Labels, Metrics } from '../../application/ports';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

function key(name: string, labels: Labels = {}): string {
  const rendered = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');

  return rendered ? `${name}{${rendered}}` : name;
}

export class MetricsRegistry implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  increment(name: string, labels?: Labels, value = 1): void {
    const id = key(name, labels);
    this.counters.set(id, (this.counters.get(id) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const id = key(name, labels);
    const histogram = this.histograms.get(id) ?? {
      buckets: BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };

    BUCKETS.forEach((bound, index) => {
      if (value <= bound) histogram.buckets[index]++;
    });
    histogram.sum += value;
    histogram.count++;
    this.histograms.set(id, histogram);
  }

  counter(name: string, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];

    for (const [id, value] of this.counters) lines.push(`${id} ${value}`);
    for (const [id, value] of this.gauges) lines.push(`${id} ${value}`);

    for (const [id, histogram] of this.histograms) {
      const [name, labelPart = ''] = id.split('{');
      const labels = labelPart ? `${labelPart.slice(0, -1)},` : '';

      BUCKETS.forEach((bound, index) =>
        lines.push(`${name}_bucket{${labels}le="${bound}"} ${histogram.buckets[index]}`),
      );
      lines.push(`${name}_bucket{${labels}le="+Inf"} ${histogram.count}`);
      lines.push(`${name}_sum${labelPart ? `{${labelPart}` : ''} ${histogram.sum}`);
      lines.push(`${name}_count${labelPart ? `{${labelPart}` : ''} ${histogram.count}`);
    }

    return `${lines.sort().join('\n')}\n`;
  }
}
