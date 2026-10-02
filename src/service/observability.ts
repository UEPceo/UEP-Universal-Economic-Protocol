/**
 * UEP-OBSERVABILITY-001 — OpenTelemetry-style layer (local implementation).
 * Failure of telemetry MUST NOT affect UEP CORE or transactions.
 */

export type SpanStatus = "ok" | "error";

export type MetricPoint = {
  name: string;
  value: number;
  labels?: Record<string, string>;
  ts: number;
};

export type SpanRecord = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
};

export interface TelemetryExporter {
  exportMetrics(points: MetricPoint[]): void;
  exportSpans(spans: SpanRecord[]): void;
}

/** Always-safe no-op exporter */
export class NoopExporter implements TelemetryExporter {
  exportMetrics(): void {}
  exportSpans(): void {}
}

/** Throws / fails — used to prove UEP continues */
export class FailingExporter implements TelemetryExporter {
  exportMetrics(): void {
    throw new Error("exporter unavailable");
  }
  exportSpans(): void {
    throw new Error("exporter unavailable");
  }
}

export class InMemoryExporter implements TelemetryExporter {
  metrics: MetricPoint[] = [];
  spans: SpanRecord[] = [];
  exportMetrics(points: MetricPoint[]): void {
    this.metrics.push(...points);
  }
  exportSpans(spans: SpanRecord[]): void {
    this.spans.push(...spans);
  }
}

function rid(): string {
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}

/**
 * UEP Telemetry facade — never throws to callers.
 */
export class UepTelemetry {
  private exporter: TelemetryExporter;
  private metrics: MetricPoint[] = [];
  private spans: SpanRecord[] = [];
  private enabled = true;
  private readonly maxMetrics = 5000;
  private readonly maxSpans = 2000;

  constructor(exporter?: TelemetryExporter) {
    this.exporter = exporter ?? new NoopExporter();
  }

  setExporter(exporter: TelemetryExporter): void {
    this.exporter = exporter;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  counter(name: string, value = 1, labels?: Record<string, string>): void {
    this.safeMetric({ name, value, labels, ts: Date.now() });
  }

  histogram(name: string, valueMs: number, labels?: Record<string, string>): void {
    this.safeMetric({ name, value: valueMs, labels, ts: Date.now() });
  }

  private safeMetric(p: MetricPoint): void {
    if (!this.enabled) return;
    try {
      this.metrics.push(p);
      if (this.metrics.length > this.maxMetrics) {
        this.metrics.splice(0, this.metrics.length - this.maxMetrics);
      }
      this.exporter.exportMetrics([p]);
    } catch {
      /* telemetry failure isolated */
    }
  }

  startSpan(
    name: string,
    attrs: Record<string, string | number | boolean> = {},
    parentSpanId?: string,
  ): SpanHandle {
    const span: SpanRecord = {
      name,
      traceId: rid(),
      spanId: rid(),
      parentSpanId,
      startMs: Date.now(),
      status: "ok",
      attributes: { ...attrs },
    };
    return new SpanHandle(this, span);
  }

  /** internal — called by SpanHandle */
  _finishSpan(span: SpanRecord): void {
    if (!this.enabled) return;
    try {
      this.spans.push(span);
      if (this.spans.length > this.maxSpans) {
        this.spans.splice(0, this.spans.length - this.maxSpans);
      }
      this.exporter.exportSpans([span]);
    } catch {
      /* isolated */
    }
  }

  snapshot(): { metrics: MetricPoint[]; spans: SpanRecord[] } {
    return {
      metrics: [...this.metrics],
      spans: [...this.spans],
    };
  }
}

export class SpanHandle {
  private tel: UepTelemetry;
  private span: SpanRecord;

  constructor(tel: UepTelemetry, span: SpanRecord) {
    this.tel = tel;
    this.span = span;
  }

  setAttr(k: string, v: string | number | boolean): void {
    this.span.attributes[k] = v;
  }

  end(status: SpanStatus = "ok"): void {
    this.span.endMs = Date.now();
    this.span.status = status;
    this.tel._finishSpan(this.span);
  }

  get spanId(): string {
    return this.span.spanId;
  }
}

/** Metric names from UEP-OBSERVABILITY-001 */
export const METRICS = {
  consensusLatency: "uep_consensus_latency",
  finalityLatency: "uep_finality_latency",
  txTotal: "uep_transactions_total",
  txFailed: "uep_transactions_failed",
  digestAggDuration: "uep_digest_aggregation_duration",
  executionDuration: "uep_execution_duration",
  storageOps: "uep_storage_operations_total",
  storageErrors: "uep_storage_errors_total",
  storageLatency: "uep_storage_latency",
  providerAvailability: "uep_provider_availability",
} as const;

export const globalTelemetry = new UepTelemetry(new NoopExporter());
