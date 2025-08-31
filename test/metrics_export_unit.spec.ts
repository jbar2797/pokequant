import { describe, it, expect } from 'vitest';
import { buildPrometheusMetricsExport } from '../src/lib/metrics_export';

describe('buildPrometheusMetricsExport', () => {
  it('builds families with representative metrics', () => {
    const body = buildPrometheusMetricsExport([
      { metric: 'universe.list', count: 3 },
      { metric: 'error.bad_request', count: 2 },
      { metric: 'error_status.400', count: 2 },
      { metric: 'req.status.2xx', count: 5 },
      { metric: 'lat.api_universe.p50', count: 25_000 }, // 25ms*1000
      { metric: 'lat.api_universe.p95', count: 40_000 },
      { metric: 'latbucket.api_universe.lt50', count: 5 }
    ]);
    expect(body).toMatch(/# TYPE pq_metric counter/);
    expect(body).toMatch(/pq_metric\{name="universe_list"} 3/);
    expect(body).toMatch(/# TYPE pq_error counter/);
    expect(body).toMatch(/pq_error\{name="error_bad_request"} 2/);
    expect(body).toMatch(/# TYPE pq_status counter/);
    expect(body).toMatch(/pq_status\{name="req_status_2xx"} 5/);
    expect(body).toMatch(/# TYPE pq_latency_bucket counter/);
    expect(body).toMatch(/pq_latency_bucket\{name="api_universe",bucket="lt50"} 5/);
    expect(body).toMatch(/# TYPE pq_latency gauge/);
    expect(body).toMatch(/pq_latency\{name="lat_api_universe",quantile="p50"} 25.00/);
  });
});
