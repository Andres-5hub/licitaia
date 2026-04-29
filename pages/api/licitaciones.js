// pages/api/licitaciones.js
// Fuentes en orden de prioridad:
//   1. compranetv2_2.sonora.gob.mx /api/proveedores/obtenerProcedimientos  (público, sin token)
//   2. compranetv2_2.sonora.gob.mx /api/procedimientos/buscarProcedimientosAdministrativos (con JWT)
//   3. compranet.sonora.gob.mx/Portal/ExportToCSV — CSV histórico público

export const config = { api: { responseLimit: "10mb" } };

import { setCORS } from "../../lib/security";

// ── constantes ────────────────────────────────────────────────────────────────
const V2_API   = "https://compranetv2_2.sonora.gob.mx";
const OLD_BASE = "https://compranet.sonora.gob.mx";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Headers exactos que usa el Angular getHeaders() — sin Authorization
const HEADERS_PUBLIC = {
  "Content-Type":              "application/json",
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PUT",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Headers con JWT para el endpoint administrativo
const headersWithToken = (token) => ({
  "Content-Type":   "application/json",
  "Authorization":  `Bearer ${token}`,
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PUT",
  "Access-Control-Allow-Headers": "Content-Type",
});

const HEADERS_FORM = {
  "User-Agent":       UA,
  "Accept":           "application/json, text/javascript, */*; q=0.01",
  "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  "Referer":          `${OLD_BASE}/portal`,
  "Origin":           OLD_BASE,
};

// ── fetch con timeout ─────────────────────────────────────────────────────────
function timedFetch(url, opts = {}, ms = 12000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(id));
}

// ── normalizar fecha ──────────────────────────────────────────────────────────
function normDate(s) {
  if (!s) return null;
  // YYYY-MM-DD HH:MM:SS → YYYY-MM-DD
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // MM/DD/YYYY → YYYY-MM-DD
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().slice(0, 10);
}

// ── normalizar registro del endpoint /api/proveedores/obtenerProcedimientos ───
function fromPortal(d) {
  return {
    id:               String(d.id_procedimiento_administrativo),
    numero:           d.numero_procedimiento || "—",
    titulo:           d.descripcion_concepto_contratacion || "—",
    dependencia:      d.nombre_unidad_responsable || d.nombre_unidad_compradora || "—",
    fechaPublicacion: normDate(d.fecha_publicacion),
    fechaLimite:      normDate(d.fecha_limite_presentacion || d.fecha_limite || null),
    estatus:          d.nombre_estatus_procedimiento || "—",
    modalidad:        d.nombre_modalidad || "—",
    tipo:             d.nombre_procedimiento || "—",
    caracter:         d.nombre_caracter_licitacion || null,
    monto:            d.monto_maximo || d.monto_estimado || null,
    anticipo:         d.porcentaje_anticipo ?? d.pct_anticipo ?? d.anticipo ?? null,
    fuente:           "v2-portal",
  };
}

// ── normalizar registro del endpoint /api/procedimientos/buscarProcedimientosAdministrativos ─
function fromV2Admin(d, i) {
  return {
    id:               String(d.id || d.numeroProcedimiento || i),
    numero:           d.numeroProcedimiento || d.numero  || "—",
    titulo:           d.descripcionProcedimiento || d.titulo || d.concepto || "—",
    dependencia:      d.unidadCompradora?.nombre || d.dependencia || "—",
    fechaPublicacion: normDate(d.fechaPublicacion || d.fechaCreacion),
    fechaLimite:      normDate(d.fechaLimite || d.fechaPresentacion),
    estatus:          d.estatus?.descripcion || d.estatus || "Vigente",
    modalidad:        d.tipoModalidad?.descripcion || d.modalidad || "—",
    tipo:             d.tipoProcedimiento?.descripcion || d.tipo    || "—",
    caracter:         null,
    monto:            d.montoMaximo || d.montoEstimado || null,
    anticipo:         d.porcentajeAnticipo ?? d.anticipo ?? null,
    fuente:           "v2-admin",
  };
}

// ── normalizar fila CSV ───────────────────────────────────────────────────────
function fromCSVRow(d, i) {
  return {
    id:               `csv-${i}`,
    numero:           d["Numero Licitacion"]      || "—",
    titulo:           d["Concepto del Contrato"]  || "—",
    dependencia:      d["Dependencia"]             || "—",
    fechaPublicacion: normDate(d["Fecha de Publicacion"]),
    fechaLimite:      normDate(d["Fecha Limite de Inscripcion"]),
    estatus:          d["Estatus"]                 || "—",
    modalidad:        d["Procedimiento"]           || "—",
    tipo:             d["Tipo de Licitacion"]      || "—",
    caracter:         null,
    monto:            null,
    anticipo:         null,
    fuente:           "portal-v1-csv",
  };
}

// ── parsear CSV robusto ───────────────────────────────────────────────────────
function parseCSV(raw) {
  const lines = [];
  let cur = "", inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQ && raw[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "\n" && !inQ) {
      lines.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);

  const toFields = (line) => {
    const fields = [];
    let f = "", inField = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inField) inField = true;
      else if (ch === '"' && inField) {
        if (line[i + 1] === '"') { f += '"'; i++; }
        else inField = false;
      } else if (ch === "," && !inField) { fields.push(f); f = ""; }
      else f += ch;
    }
    fields.push(f);
    return fields;
  };

  const [headerLine, ...dataLines] = lines.filter(l => l.trim());
  if (!headerLine) return [];
  const headers = toFields(headerLine).map(h => h.trim());
  return dataLines
    .filter(l => l.trim())
    .map(line => {
      const vals = toFields(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i]?.trim() ?? ""; });
      return obj;
    });
}

// ── Strategy 1: endpoint público del portal v2 (SIN autenticación) ────────────
// Este es el mismo endpoint que usa el Angular en /inicio/portal-licitaciones
async function tryV2Portal() {
  // Traer VIGENTE (estatus_procedimiento: 2) y todos los tipos
  const body = {
    unidad_responsable:      null,
    concepto_contratacion:   null,
    no_licitacion:           null,
    tipo_licitacion:         null,   // null = todos (LP + LS)
    tipo_procedimiento:      null,
    estatus_procedimiento:   2,      // 2 = VIGENTE
    fecha_inicial:           null,
    fecha_final:             null,
    page:                    "1",
    pageSize:                "500",
  };

  try {
    const res = await timedFetch(
      `${V2_API}/api/proveedores/obtenerProcedimientos`,
      { method: "POST", headers: HEADERS_PUBLIC, body: JSON.stringify(body) },
      12000
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json?.datos?.data?.length) return null;

    const rows = json.datos.data.map(fromPortal);
    return { rows, fuente: "api-v2-portal", total: json.datos.total || rows.length };
  } catch {
    return null;
  }
}

// ── Strategy 2: endpoint administrativo con JWT (más datos, si hay token) ─────
async function tryV2WithToken(token) {
  const bodies = [
    { pagina: 1, registrosPorPagina: 200, estatus: "VIGENTE" },
    { pagina: 1, registrosPorPagina: 200 },
  ];

  for (const body of bodies) {
    try {
      const res = await timedFetch(
        `${V2_API}/api/procedimientos/buscarProcedimientosAdministrativos`,
        { method: "POST", headers: headersWithToken(token), body: JSON.stringify(body) }
      );
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      if (!json) continue;
      const arr = json.datos || json.data || json.results || (Array.isArray(json) ? json : null);
      if (arr?.length > 0)
        return { rows: arr.map(fromV2Admin), fuente: "api-v2-jwt", total: arr.length };
    } catch { /* timeout o red */ }
  }
  return null;
}

// ── Strategy 3: CSV histórico del portal público (último recurso) ─────────────
const fmtDate = (d) =>
  `${String(d.getMonth()+1).padStart(2,"0")}%2F${String(d.getDate()).padStart(2,"0")}%2F${d.getFullYear()}`;

async function fetchCSVRange(from, to) {
  const url = `${OLD_BASE}/Portal/ExportToCSV?UR=&lic=&status=&cpto=&fecI=${fmtDate(from)}&fecF=${fmtDate(to)}&proc=&noexp=`;
  try {
    const res = await timedFetch(url, { headers: { "User-Agent": UA, "Referer": `${OLD_BASE}/portal` } }, 12000);
    if (!res.ok) return [];
    const text = await res.text();
    if (!text || text.length < 100) return [];
    return parseCSV(text).map(fromCSVRow);
  } catch {
    return [];
  }
}

async function tryCSV() {
  const now = new Date();
  const ranges = [
    [new Date(2022, 0, 1), new Date(2023, 11, 31)],
    [new Date(2024, 0, 1), now],
  ];

  const chunks = await Promise.allSettled(ranges.map(([from, to]) => fetchCSVRange(from, to)));

  const seen = new Set();
  const allRows = [];
  for (const chunk of chunks) {
    if (chunk.status !== "fulfilled") continue;
    for (const row of chunk.value) {
      const key = row.numero !== "—" ? row.numero : `${row.titulo}|${row.fechaPublicacion}`;
      if (!seen.has(key)) { seen.add(key); allRows.push(row); }
    }
  }

  if (allRows.length === 0) return null;

  allRows.sort((a, b) => (b.fechaPublicacion || "").localeCompare(a.fechaPublicacion || ""));
  return { rows: allRows, fuente: "portal-v1-csv", total: allRows.length };
}

// ── handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const corsOk = setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!corsOk)                  return res.status(403).json({ error: "Origen no permitido" });
  if (req.method !== "GET")     return res.status(405).json({ error: "Método no permitido" });

  const token = req.query?.token || req.headers?.["x-compranet-token"] || "";

  let result = null;

  // 1. Endpoint público del portal v2 — VIGENTE sin autenticación
  result = await tryV2Portal().catch(() => null);

  // 2. Si hay JWT → endpoint administrativo (puede complementar o reemplazar)
  if (!result && token) {
    result = await tryV2WithToken(token).catch(() => null);
  }

  // 3. CSV histórico del portal v1 como último recurso
  if (!result) {
    result = await tryCSV().catch(() => null);
  }

  if (result) {
    return res.status(200).json({
      licitaciones: result.rows,
      fuente:       result.fuente,
      total:        result.total,
      timestamp:    new Date().toISOString(),
      conToken:     !!token,
    });
  }

  return res.status(200).json({
    licitaciones: [],
    fuente:       "empty",
    total:        0,
    timestamp:    new Date().toISOString(),
    conToken:     !!token,
    mensaje:      "No se pudo obtener datos del portal CompraNet Sonora. Intenta nuevamente.",
  });
}
