/**
 * Display-only GLEIF lookup. Not a protocol input.
 *
 * The interface may show the legal name and registration status of an LEI so
 * an operator does not treat a checksum-valid identifier as a living entity.
 * The answer changes, expires, and is not seen by every node. It never enters
 * a policy decision, a quote, a settlement or ledger state. If GLEIF does not
 * answer, the caller still gets the offline checksum result and the time of
 * the attempt.
 */
import { isValidLei } from "../oracle/lei.ts";

export const GLEIF_RECORDS_ORIGIN = "https://api.gleif.org";
export const GLEIF_DISPLAY_NOTE =
  "Display only. A GLEIF answer is not evidence, not a policy input and not ledger state. A checksum does not prove the entity exists.";

export type GleifDisplay = {
  lei: string;
  checksumValid: boolean;
  /** ISO-8601 time of this consultation, set even when GLEIF is not called. */
  queriedAt: string;
  source: "offline" | "gleif";
  available: boolean;
  legalName: string | null;
  registrationStatus: string | null;
  gleifUrl: string | null;
  note: string;
};

export type GleifDisplayOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

function recordsUrl(lei: string): string {
  return `${GLEIF_RECORDS_ORIGIN}/api/v1/lei-records/${encodeURIComponent(lei)}`;
}

function base(lei: string, queriedAt: string, checksumValid: boolean): GleifDisplay {
  return {
    lei,
    checksumValid,
    queriedAt,
    source: "offline",
    available: false,
    legalName: null,
    registrationStatus: null,
    gleifUrl: checksumValid ? recordsUrl(lei) : null,
    note: GLEIF_DISPLAY_NOTE,
  };
}

function readName(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const attributes = (data as { attributes?: unknown }).attributes;
  if (!attributes || typeof attributes !== "object") return null;
  const entity = (attributes as { entity?: unknown }).entity;
  if (!entity || typeof entity !== "object") return null;
  const legalName = (entity as { legalName?: unknown }).legalName;
  if (!legalName || typeof legalName !== "object") return null;
  const name = (legalName as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

function readStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const attributes = (data as { attributes?: unknown }).attributes;
  if (!attributes || typeof attributes !== "object") return null;
  const registration = (attributes as { registration?: unknown }).registration;
  if (!registration || typeof registration !== "object") return null;
  const status = (registration as { status?: unknown }).status;
  return typeof status === "string" && status.trim() !== "" ? status : null;
}

/**
 * Resolve an LEI for display. Never throws. Does not call the network unless
 * the offline check passes. A missing registry leaves `available: false`.
 */
export async function displayLei(lei: string, opts: GleifDisplayOptions = {}): Promise<GleifDisplay> {
  const queriedAt = (opts.now ?? (() => new Date()))().toISOString();
  const normalized = typeof lei === "string" ? lei.trim().toUpperCase() : "";
  if (!isValidLei(normalized)) {
    return { ...base(normalized, queriedAt, false), note: `${GLEIF_DISPLAY_NOTE} Offline check failed; GLEIF was not called.` };
  }
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const url = recordsUrl(normalized);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.url && !res.url.startsWith(`${GLEIF_RECORDS_ORIGIN}/`)) {
      return { ...base(normalized, queriedAt, true), note: `${GLEIF_DISPLAY_NOTE} Registry redirect left api.gleif.org; ignored.` };
    }
    if (!res.ok) {
      return { ...base(normalized, queriedAt, true), note: `${GLEIF_DISPLAY_NOTE} Registry answered HTTP ${res.status}; the interface continues without it.` };
    }
    const body: unknown = await res.json();
    const legalName = readName(body);
    const registrationStatus = readStatus(body);
    if (!legalName && !registrationStatus) {
      return { ...base(normalized, queriedAt, true), note: `${GLEIF_DISPLAY_NOTE} Registry body had no legal name or status.` };
    }
    return {
      lei: normalized,
      checksumValid: true,
      queriedAt,
      source: "gleif",
      available: true,
      legalName,
      registrationStatus,
      gleifUrl: url,
      note: GLEIF_DISPLAY_NOTE,
    };
  } catch {
    return { ...base(normalized, queriedAt, true), note: `${GLEIF_DISPLAY_NOTE} Registry unreachable; the interface continues without it.` };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Operator page. Works when the registry does not. No script, no external asset. */
export function renderLeiDisplayPage(view: GleifDisplay | null, entered: string): string {
  const row = view
    ? `<p>Consulta: <time datetime="${escapeHtml(view.queriedAt)}">${escapeHtml(view.queriedAt)}</time></p>
<dl>
<dt>LEI</dt><dd>${escapeHtml(view.lei)}</dd>
<dt>Suma offline</dt><dd>${view.checksumValid ? "válida (no prueba que la entidad exista)" : "rechazada; GLEIF no se ha consultado"}</dd>
<dt>Nombre legal</dt><dd>${view.legalName ? escapeHtml(view.legalName) : "no disponible"}</dd>
<dt>Estado de registro</dt><dd>${view.registrationStatus ? escapeHtml(view.registrationStatus) : "no disponible"}</dd>
<dt>Fuente</dt><dd>${escapeHtml(view.source)}</dd>
</dl>
<p>${escapeHtml(view.note)}</p>`
    : "<p>Identificador opcional. La suma se comprueba sin red. El nombre solo se muestra si GLEIF responde.</p>";
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>LEI — solo pantalla</title></head>
<body>
<h1>LEI, solo pantalla</h1>
<p>No entra en una política, un quote ni en el estado. Si el registro no responde, esta página sigue.</p>
<form method="get" action="/v1/display/lei">
<label>LEI <input name="lei" value="${escapeHtml(entered)}" maxlength="20" autocomplete="off"></label>
<button type="submit">Consultar</button>
</form>
${row}
</body>
</html>`;
}
