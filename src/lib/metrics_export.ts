// Metrics Prometheus export builder
// Converts a list of { metric, count } rows (current day) from metrics_daily
// into a Prometheus exposition format string with families:
// pq_metric (generic counters), pq_error (error.*), pq_status (error_status.* / req.status.*),
// pq_latency_bucket (latbucket.* histogram-ish buckets), pq_latency (EMA p50/p95 gauges in ms)
// pq_error_codes (gauge with distinct error.* codes that occurred today)

export interface MetricRow { metric: string; count: number }

const sanitize = (m: string) => m.replace(/[^a-zA-Z0-9_:]/g, '_');

export function buildPrometheusMetricsExport(rows: MetricRow[]): string {
  const latencyMap: Record<string, { p50?: number; p95?: number }> = {};
  const errors: MetricRow[] = [];
  const statusFamilies: MetricRow[] = [];
  const latencyBuckets: { tag: string; bucket: string; count: number }[] = [];
  const sloCounters: Record<string, { good: number; breach: number }> = {};
  const other: MetricRow[] = [];
  for (const r of rows) {
    const metric = String(r.metric || '');
    if (!metric) continue;
    if (metric.endsWith('.p50') || metric.endsWith('.p95')) {
      const base = metric.replace(/\.(p50|p95)$/,'');
      const entry = (latencyMap[base] ||= {});
      if (metric.endsWith('.p50')) entry.p50 = Number(r.count) || 0; else entry.p95 = Number(r.count) || 0;
    } else if (metric.startsWith('latbucket.')) {
      const parts = metric.split('.');
      if (parts.length === 3) {
        latencyBuckets.push({ tag: parts[1], bucket: parts[2], count: Number(r.count)||0 });
      }
    } else if (metric.startsWith('error.')) {
      errors.push({ metric, count: Number(r.count)||0 });
    } else if (metric.startsWith('error_status.') || metric.startsWith('req.status.')) {
      statusFamilies.push({ metric, count: Number(r.count)||0 });
    } else if (metric.startsWith('req.slo.route.') && (metric.endsWith('.good') || metric.endsWith('.breach'))) {
      const parts = metric.split('.'); // req.slo.route.<slug>.<kind>
      if (parts.length >= 5) {
        const slug = parts.slice(3, parts.length-1).join('.');
        const kind = parts[parts.length-1];
        const entry = (sloCounters[slug] ||= { good:0, breach:0 });
        if (kind === 'good') entry.good += Number(r.count)||0; else entry.breach += Number(r.count)||0;
      }
    } else {
      other.push({ metric, count: Number(r.count)||0 });
    }
  }
  let body = '# HELP pq_metric Daily counter metrics (resets daily)\n# TYPE pq_metric counter\n';
  for (const o of other.sort((a,b)=> a.metric.localeCompare(b.metric))) {
    body += `pq_metric{name="${sanitize(o.metric)}"} ${o.count}\n`;
  }
  if (errors.length) {
    body += '# HELP pq_error Error code counters\n# TYPE pq_error counter\n';
    for (const e of errors.sort((a,b)=> a.metric.localeCompare(b.metric))) {
      body += `pq_error{name="${sanitize(e.metric)}"} ${e.count}\n`;
    }
    // Distinct error codes gauge
    body += '# HELP pq_error_codes Distinct error codes observed today\n# TYPE pq_error_codes gauge\n';
    body += `pq_error_codes ${errors.length}\n`;
  }
  if (statusFamilies.length) {
    body += '# HELP pq_status Status family counters (error_status.*, req.status.*)\n# TYPE pq_status counter\n';
    for (const s of statusFamilies.sort((a,b)=> a.metric.localeCompare(b.metric))) {
      body += `pq_status{name="${sanitize(s.metric)}"} ${s.count}\n`;
    }
  }
  if (latencyBuckets.length) {
    body += '# HELP pq_latency_bucket Latency bucket counters (requests per bucket)\n# TYPE pq_latency_bucket counter\n';
    for (const b of latencyBuckets.sort((a,b)=> (a.tag+a.bucket).localeCompare(b.tag+b.bucket))) {
      body += `pq_latency_bucket{name="${sanitize(b.tag)}",bucket="${sanitize(b.bucket)}"} ${b.count}\n`;
    }
  }
  if (Object.keys(sloCounters).length) {
    body += '# HELP pq_slo_burn Daily SLO burn ratio per route (breach/(good+breach))\n# TYPE pq_slo_burn gauge\n';
    for (const slug of Object.keys(sloCounters).sort()) {
      const { good, breach } = sloCounters[slug];
      const total = good + breach;
      const ratio = total ? breach/total : 0;
      body += `pq_slo_burn{route="${sanitize(slug)}"} ${ratio.toFixed(6)}\n`;
    }
  }
  body += '# HELP pq_latency Latency metrics (EMA p50/p95 in ms)\n# TYPE pq_latency gauge\n';
  for (const base of Object.keys(latencyMap).sort()) {
    const { p50, p95 } = latencyMap[base];
    if (p50 != null) body += `pq_latency{name="${sanitize(base)}",quantile="p50"} ${(p50/1000).toFixed(2)}\n`;
    if (p95 != null) body += `pq_latency{name="${sanitize(base)}",quantile="p95"} ${(p95/1000).toFixed(2)}\n`;
  }
  return body;
}
