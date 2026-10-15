/**
 * 0.5.82: display-only indicative figures from ECB, BIS, Eurostat and the
 * World Bank (same pattern as gleif-display.ts). Not a protocol input.
 *
 * A figure shown here is an indicative equivalence for the operator's
 * interface. It never enters a policy decision, a quote, a settlement, an
 * oracle reference or ledger state, and no module under src/ outside this
 * display reads it. If a source does not answer (timeout, HTTP error, body
 * without a value) the page shows "no disponible" and keeps working. Each
 * figure carries the source's attribution. The reuse terms of these four
 * sources have not been reviewed for this project; treat the display as
 * informational only.
 */

export type IndicativeSourceId = "ECB" | "BIS" | "EUROSTAT" | "WORLDBANK";

export type IndicativeSource = {
  id: IndicativeSourceId;
  label: string;
  url: string;
  attribution: string;
  /** Extracts { value, period } from the parsed body, or null. */
  parse: (body: unknown) => { value: string; period: string | null } | null;
};

export const INDICATIVE_DISPLAY_NOTE =
  "Solo pantalla. Equivalencia indicativa: no es una cotización, ni una entrada de política, ni estado del ledger. UEP no depende de estas fuentes.";

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);

/** ECB SDMX-JSON: last observation of the series. */
function parseSdmxJson(body: unknown): { value: string; period: string | null } | null {
  const ds = obj(body)?.dataSets;
  if (!Array.isArray(ds)) return null;
  const series = obj(obj(ds[0])?.series);
  if (!series) return null;
  const first = obj(Object.values(series)[0]);
  const obs = obj(first?.observations);
  if (!obs) return null;
  const keys = Object.keys(obs).sort((a, b) => Number(a) - Number(b));
  const last = keys.at(-1);
  if (last === undefined) return null;
  const cell = obs[last];
  const value = num(Array.isArray(cell) ? cell[0] : null);
  if (value === null) return null;
  const dims = obj(obj(obj(body)?.structure)?.dimensions);
  const timeValues = Array.isArray(dims?.observation) ? (obj(dims!.observation[0] as unknown)?.values as unknown[] | undefined) : undefined;
  const period = Array.isArray(timeValues) ? (obj(timeValues[Number(last)])?.id as string | undefined) ?? null : null;
  return { value, period };
}

/** Eurostat JSON-stat 2.0: the single (or last) value. */
function parseJsonStat(body: unknown): { value: string; period: string | null } | null {
  const b = obj(body);
  const values = b?.value;
  let value: string | null = null;
  if (Array.isArray(values)) value = num(values.at(-1));
  else if (obj(values)) { const ks = Object.keys(values as object).sort((x, y) => Number(x) - Number(y)); value = num((values as Record<string, unknown>)[ks.at(-1) ?? ""]); }
  if (value === null) return null;
  const time = obj(obj(obj(b?.dimension)?.time)?.category)?.index;
  const period = obj(time) ? Object.keys(time as object).at(-1) ?? null : null;
  return { value, period };
}

/** World Bank API v2: [meta, [ {value, date}, ... ]]. */
function parseWorldBank(body: unknown): { value: string; period: string | null } | null {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return null;
  for (const row of body[1] as unknown[]) {
    const r = obj(row);
    const value = num(r?.value);
    if (value !== null) return { value, period: typeof r?.date === "string" ? r.date : null };
  }
  return null;
}

export const INDICATIVE_SOURCES: Record<IndicativeSourceId, IndicativeSource> = {
  ECB: {
    id: "ECB",
    label: "Tipo de referencia EUR/USD (BCE)",
    url: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata",
    attribution: "Fuente: Banco Central Europeo (ECB Data Portal).",
    parse: parseSdmxJson,
  },
  BIS: {
    id: "BIS",
    label: "Tipo de cambio USD por EUR (BIS)",
    url: "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_XRU/1.0/D.XM.EUR.A?lastNObservations=1&format=jsondata",
    attribution: "Fuente: Bank for International Settlements (BIS Data Portal).",
    parse: parseSdmxJson,
  },
  EUROSTAT: {
    id: "EUROSTAT",
    label: "Inflación interanual IPCA, zona euro (Eurostat)",
    url: "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr?geo=EA&coicop=CP00&lastTimePeriod=1",
    attribution: "Fuente: Eurostat (prc_hicp_manr).",
    parse: parseJsonStat,
  },
  WORLDBANK: {
    id: "WORLDBANK",
    label: "Inflación, precios al consumidor (% anual), España (Banco Mundial)",
    url: "https://api.worldbank.org/v2/country/ESP/indicator/FP.CPI.TOTL.ZG?format=json&mrv=1",
    attribution: "Fuente: Banco Mundial, World Development Indicators (CC BY 4.0).",
    parse: parseWorldBank,
  },
};

export type IndicativeDisplay = {
  source: IndicativeSourceId;
  label: string;
  queriedAt: string;
  available: boolean;
  value: string | null;
  period: string | null;
  sourceUrl: string;
  attribution: string;
  note: string;
};

export type IndicativeDisplayOptions = { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date };

/** One source for display. Never throws; a missing source leaves `available: false`. */
export async function displayIndicative(id: IndicativeSourceId, opts: IndicativeDisplayOptions = {}): Promise<IndicativeDisplay> {
  const src = INDICATIVE_SOURCES[id];
  const queriedAt = (opts.now ?? (() => new Date()))().toISOString();
  const base: IndicativeDisplay = { source: id, label: src.label, queriedAt, available: false, value: null, period: null, sourceUrl: src.url, attribution: src.attribution, note: INDICATIVE_DISPLAY_NOTE };
  try {
    const origin = new URL(src.url).origin;
    const res = await (opts.fetch ?? fetch)(src.url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 2500) });
    if (res.url && !res.url.startsWith(`${origin}/`)) return { ...base, note: `${INDICATIVE_DISPLAY_NOTE} Redirección fuera de ${origin}; ignorada.` };
    if (!res.ok) return { ...base, note: `${INDICATIVE_DISPLAY_NOTE} La fuente respondió HTTP ${res.status}.` };
    const parsed = src.parse(await res.json());
    if (!parsed) return { ...base, note: `${INDICATIVE_DISPLAY_NOTE} Respuesta sin valor.` };
    return { ...base, available: true, value: parsed.value, period: parsed.period };
  } catch {
    return { ...base, note: `${INDICATIVE_DISPLAY_NOTE} Fuente no disponible; la interfaz sigue sin ella.` };
  }
}

/** All four sources, queried in parallel; each one fails independently. */
export async function displayAllIndicative(opts: IndicativeDisplayOptions = {}): Promise<IndicativeDisplay[]> {
  return Promise.all((Object.keys(INDICATIVE_SOURCES) as IndicativeSourceId[]).map((id) => displayIndicative(id, opts)));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Operator page. Works when every source is down. No script, no external asset. */
export function renderIndicativePage(views: IndicativeDisplay[]): string {
  const rows = views.map((v) => `<tr><td>${escapeHtml(v.label)}</td><td>${v.available && v.value !== null ? escapeHtml(v.value) : "no disponible"}</td><td>${v.period ? escapeHtml(v.period) : "—"}</td><td><time datetime="${escapeHtml(v.queriedAt)}">${escapeHtml(v.queriedAt)}</time></td><td>${escapeHtml(v.attribution)}</td></tr>`).join("\n");
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Indicadores — solo pantalla</title></head>
<body>
<h1>Indicadores, solo pantalla</h1>
<p>${escapeHtml(INDICATIVE_DISPLAY_NOTE)}</p>
<table>
<thead><tr><th>Indicador</th><th>Valor</th><th>Periodo</th><th>Consulta</th><th>Atribución</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
}
