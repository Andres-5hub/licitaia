// pages/api/licitaciones.js
// Fuentes sin Puppeteer, compatibles con Vercel:
//   1. compranetv2_2.sonora.gob.mx — API REST v2  (requiere JWT en query ?token=)
//   2. compranet.sonora.gob.mx/Portal/LoadData    — DataTables JSON público
//   3. compranet.sonora.gob.mx/Portal/ExportToCSV — CSV histórico público

export const config = { api: { responseLimit: "10mb" } };

// ── constantes ────────────────────────────────────────────────────────────────
const V2_API    = "https://compranetv2_2.sonora.gob.mx";
const OLD_BASE  = "https://compranet.sonora.gob.mx";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HEADERS_JSON = {
  "User-Agent":          UA,
  "Accept":              "application/json, text/javascript, */*; q=0.01",
  "Accept-Language":     "es-MX,es;q=0.9,en;q=0.8",
  "Content-Type":        "application/json",
  "Origin":              "https://compranetv2.sonora.gob.mx",
  "Referer":             "https://compranetv2.sonora.gob.mx/inicio/portal-licitaciones",
};

const HEADERS_FORM = {
  "User-Agent":          UA,
  "Accept":              "application/json, text/javascript, */*; q=0.01",
  "Accept-Language":     "es-MX,es;q=0.9,en;q=0.8",
  "Content-Type":        "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With":    "XMLHttpRequest",
  "Referer":             `${OLD_BASE}/portal`,
  "Origin":              OLD_BASE,
};

// ── fetch con timeout ─────────────────────────────────────────────────────────
function timedFetch(url, opts = {}, ms = 9000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(id));
}

// ── normalizar fecha ──────────────────────────────────────────────────────────
function normDate(s) {
  if (!s) return null;
  // MM/DD/YYYY → YYYY-MM-DD
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().slice(0, 10);
}

// ── normalizar registros del API v2 ──────────────────────────────────────────
function fromV2(d, i) {
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
    monto:            d.montoMaximo || d.montoEstimado || null,
    fuente:           "v2",
  };
}

// ── normalizar filas del DataTables JSON del portal viejo ────────────────────
function fromDTRow(d, i) {
  return {
    id:               String(d.ID || i),
    numero:           d.NoLicitacion || "—",
    titulo:           d.Concepto     || "—",
    dependencia:      d.Dependencia  || "—",
    fechaPublicacion: normDate(d.Fecha),
    fechaLimite:      null,
    estatus:          d.Estatus      || "—",
    modalidad:        d.Procedimiento || "—",
    tipo:             d.Tipo         || "—",
    monto:            null,
    fuente:           "portal-v1",
  };
}

// ── parsear CSV robusto (maneja campos con comas y saltos dentro de comillas) ─
function parseCSV(raw) {
  const lines = [];
  let cur = "", inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQ && raw[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "\n" && !inQ) {
      lines.push(cur);
      cur = "";
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
      if (ch === '"' && !inField) { inField = true; }
      else if (ch === '"' && inField) {
        if (line[i + 1] === '"') { f += '"'; i++; }
        else inField = false;
      } else if (ch === "," && !inField) { fields.push(f); f = ""; }
      else f += ch;
    }
    fields.push(f);
    return fields;
  };

  const [headerLine, ...dataLines] = lines.filter((l) => l.trim());
  const headers = toFields(headerLine).map((h) => h.trim());
  return dataLines
    .filter((l) => l.trim())
    .map((line) => {
      const vals = toFields(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i]?.trim() ?? ""; });
      return obj;
    });
}

function fromCSVRow(d, i) {
  return {
    id:               `csv-${i}`,
    numero:           d["Numero Licitacion"]   || "—",
    titulo:           d["Concepto del Contrato"] || "—",
    dependencia:      d["Dependencia"]          || "—",
    fechaPublicacion: normDate(d["Fecha de Publicacion"]),
    fechaLimite:      normDate(d["Fecha Limite de Inscripcion"]),
    estatus:          d["Estatus"]              || "—",
    modalidad:        d["Procedimiento"]        || "—",
    tipo:             d["Tipo de Licitacion"]   || "—",
    monto:            null,
    fuente:           "portal-v1-csv",
  };
}

// ── Strategy 1: API v2 con JWT ────────────────────────────────────────────────
async function tryV2WithToken(token) {
  const bodies = [
    { pagina: 1, registrosPorPagina: 200, estatus: "VIGENTE" },
    { pagina: 1, registrosPorPagina: 200 },
  ];

  for (const body of bodies) {
    try {
      const res = await timedFetch(
        `${V2_API}/api/procedimientos/buscarProcedimientosAdministrativos`,
        {
          method:  "POST",
          headers: {
            ...HEADERS_JSON,
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      if (!json) continue;
      const arr = json.datos || json.data || json.results || (Array.isArray(json) ? json : null);
      if (arr?.length > 0) return { rows: arr.map(fromV2), fuente: "api-v2-jwt", total: arr.length };
    } catch { /* timeout o red */ }
  }
  return null;
}

// ── Strategy 2: DataTables JSON del portal público ────────────────────────────
// Construye el body DataTables server-side con los 9 columnas del portal
function buildDTBody(options = {}) {
  const {
    estatus    = "",
    tipo       = "",       // LicitacionPublica | LicitacionSimplificada | ""
    start      = 0,
    length     = 200,
  } = options;

  const cols = [
    { data: "Estatus",      name: "Estatus",      search: estatus },
    { data: "NoLicitacion", name: "NoLicitacion",  search: "" },
    { data: "Concepto",     name: "Concepto",      search: "" },
    { data: "Dependencia",  name: "Dependencia",   search: "" },
    { data: "Fecha",        name: "Fecha",         search: "" },
    { data: null,           name: "",              searchable: false, orderable: false, search: "" },
    { data: "ID",           name: "ID",            search: tipo },
    { data: "Tipo",         name: "Tipo",          search: "" },
    { data: "Procedimiento",name: "Procedimiento", searchable: false, search: "false" },
  ];

  const params = new URLSearchParams();
  params.set("draw", "1");
  params.set("start", String(start));
  params.set("length", String(length));
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  params.set("order[0][column]", "4");
  params.set("order[0][dir]", "desc");

  cols.forEach((col, i) => {
    params.set(`columns[${i}][data]`,            String(col.data ?? "null"));
    params.set(`columns[${i}][name]`,            col.name);
    params.set(`columns[${i}][searchable]`,      String(col.searchable !== false));
    params.set(`columns[${i}][orderable]`,       String(col.orderable !== false));
    params.set(`columns[${i}][search][value]`,   col.search ?? "");
    params.set(`columns[${i}][search][regex]`,   "false");
  });

  return params.toString();
}

async function tryDataTables() {
  // Pedir todos los tipos en paralelo
  const requests = [
    timedFetch(`${OLD_BASE}/Portal/LoadData?first=True`, { method: "POST", headers: HEADERS_FORM, body: buildDTBody({ tipo: "LicitacionPublica" }) }),
    timedFetch(`${OLD_BASE}/Portal/LoadData?first=True`, { method: "POST", headers: HEADERS_FORM, body: buildDTBody({ tipo: "LicitacionSimplificada" }) }),
    timedFetch(`${OLD_BASE}/Portal/LoadData?first=True`, { method: "POST", headers: HEADERS_FORM, body: buildDTBody({ tipo: "" }) }),
  ];

  const rows = [];
  const seen = new Set();

  for (const req of requests) {
    try {
      const res = await req;
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      if (!json?.data) continue;
      for (const d of json.data) {
        if (!seen.has(d.ID)) { seen.add(d.ID); rows.push(fromDTRow(d, rows.length)); }
      }
    } catch { /* timeout */ }
  }

  if (rows.length > 0) return { rows, fuente: "portal-v1-dt", total: rows.length };
  return null;
}

// ── Strategy 3: CSV histórico del portal público ──────────────────────────────
async function tryCSV() {
  // Pedir últimos 18 meses
  const now    = new Date();
  const cutoff = new Date(now.getFullYear() - 1, now.getMonth() - 6, 1);
  const fmt = (d) =>
    `${String(d.getMonth()+1).padStart(2,"0")}%2F${String(d.getDate()).padStart(2,"0")}%2F${d.getFullYear()}`;

  const url = `${OLD_BASE}/Portal/ExportToCSV?UR=&lic=&status=&cpto=&fecI=${fmt(cutoff)}&fecF=${fmt(now)}&proc=&noexp=`;

  try {
    const res = await timedFetch(url, { headers: { "User-Agent": UA, "Referer": `${OLD_BASE}/portal` } });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 100) return null;

    const records = parseCSV(text);
    if (records.length === 0) return null;

    // Ordenar por fecha desc
    const rows = records
      .map(fromCSVRow)
      .sort((a, b) => (b.fechaPublicacion || "").localeCompare(a.fechaPublicacion || ""));

    return { rows, fuente: "portal-v1-csv", total: rows.length };
  } catch {
    return null;
  }
}

// ── handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido" });

  const token = req.query?.token || req.headers?.["x-compranet-token"] || "";

  let result = null;

  // 1. Si hay JWT → intentar v2 primero
  if (token) {
    result = await tryV2WithToken(token).catch(() => null);
  }

  // 2. DataTables JSON (portal v1 público)
  if (!result) {
    result = await tryDataTables().catch(() => null);
  }

  // 3. CSV histórico (portal v1 público)
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
