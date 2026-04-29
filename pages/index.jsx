import { useState, useRef, useCallback, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE CONFIG ──────────────────────────────────────────────────────────
const supabase = createClient(
  "https://bojjcutpkhmonhizycsg.supabase.co",
  "sb_publishable_4-zzgz73Pu0B3oXrlv2Qdw_mJ21NOZA"
);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_BASE = "";
const skEmpresa      = (uid) => `licitaia_${uid}_empresa`;
const skHistorial    = (uid) => `licitaia_${uid}_historial`;
const skLicitaciones = (uid) => `licitaia_${uid}_licitaciones`;

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const store = {
  get: (k)    => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k)    => { try { localStorage.removeItem(k); } catch {} },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function safeParse(text) {
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { return null; }
}
function validateStructure(data) {
  if (!data) return false;
  if (!data.resumen || !data.requisitos || !data.conclusion) return false;
  if (!Array.isArray(data.requisitos)) return false;
  return true;
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => { const b64 = e.target.result?.split(",")[1]; b64 ? resolve(b64) : reject(new Error("No se pudo leer el archivo")); };
    reader.onerror = () => reject(new Error("Error leyendo el archivo"));
    reader.readAsDataURL(file);
  });
}
function buildFallback(tipo) {
  return {
    tipo, resumen: "No se pudo analizar. Intenta nuevamente.",
    licitacion: { nombre:"—", organismo:"—", objeto:"—", monto:"—", plazo_presentacion:"—", plazo_ejecucion:"—" },
    veredicto:"REVISAR", score:null, score_razon:null, requisitos:[],
    riesgos:["Error en análisis — revisar manualmente."],
    conclusion:"Análisis no disponible. Recomendación: Participar con precaución",
  };
}
async function analyzeWithBackend(payload) {
  const { base64PDF, tipo, empresa } = payload;
  const res = await fetch(`${API_BASE}/api/analyze`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ base64PDF, tipo, empresa: empresa || null }),
  });
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error || `Error ${res.status}`); }
  const body = await res.json().catch(()=>({}));
  if (!body.data) throw new Error("El servidor no devolvió datos");
  if (!validateStructure(body.data)) return { data: buildFallback(tipo), warnings:["Formato inesperado del servidor."] };
  return { data: body.data, warnings: body.warnings || [] };
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const fmtSize  = (b) => b < 1e6 ? (b/1024).toFixed(0)+" KB" : (b/1e6).toFixed(1)+" MB";
const fmtDate  = (d) => new Date(d).toLocaleDateString("es-AR", {day:"2-digit",month:"short",year:"numeric"});
const scoreCol = (s) => s >= 70 ? "#10b981" : s >= 45 ? "#f59e0b" : "#ef4444";

// ─── RATE LIMIT (licitaciones, 3 usos / 24 h) ────────────────────────────────
const SK_LICIT_RATE  = "licitaia_v4_licit_rate";
const LICIT_MAX_USOS = 3;
const LICIT_WINDOW   = 24 * 60 * 60 * 1000; // 24 h en ms

function getRateLimit() {
  try {
    const d = JSON.parse(localStorage.getItem(SK_LICIT_RATE) || "null");
    if (!d) return { usos: 0, ultima: null, resetAt: null };
    if (d.resetAt && Date.now() > d.resetAt) return { usos: 0, ultima: null, resetAt: null };
    return d;
  } catch { return { usos: 0, ultima: null, resetAt: null }; }
}
function consumeRateLimit(current) {
  const next = {
    usos:    current.usos + 1,
    ultima:  Date.now(),
    resetAt: current.resetAt || (Date.now() + LICIT_WINDOW),
  };
  try { localStorage.setItem(SK_LICIT_RATE, JSON.stringify(next)); } catch {}
  return next;
}

// ─── SCORING EMPRESA vs LICITACIÓN ───────────────────────────────────────────
const SECTOR_KW = {
  "Tecnología":   ["sistemas","software","hardware","tecnología","informática","digital","cómputo","red","aplicación","plataforma","ti","desarrollo","ciberseguridad","servidor","base de datos","licencia"],
  "Construcción": ["obra","construcción","infraestructura","edificio","puente","carretera","rehabilitación","remodelación","pavimento","urbanización","drenaje","alcantarillado","pavimentación"],
  "Consultoría":  ["consultoría","asesoría","capacitación","estudio","diagnóstico","evaluación","análisis","planeación","consultor","auditoría"],
  "Salud":        ["médico","hospital","salud","medicamento","clínico","sanitario","farmacéutico","equipo médico","insumo","quirúrgico","laboratorio","ambulancia"],
  "Educación":    ["escuela","educativo","universidad","académico","didáctico","enseñanza","formación","bachillerato","colegio","material educativo","aula"],
  "Logística":    ["logística","transporte","flete","distribución","almacén","entrega","paquetería","mudanza","vehículo","vehículos","camión"],
  "Servicios":    ["servicio","mantenimiento","limpieza","vigilancia","jardinería","aseo","operación","cafetería","fumigación","poda","recolección"],
  "Manufactura":  ["fabricación","manufactura","producción","ensamble","industria","suministro","material","acero","metal","maquinaria"],
  "Seguridad":    ["seguridad","vigilancia","custodia","protección","guardias","resguardo","cámaras","video vigilancia","monitoreo"],
  "Otro":         [],
};

const FACTURACION_TOPES = {
  "Menos de $500K":  500_000,
  "$500K – $2M":   2_000_000,
  "$2M – $10M":   10_000_000,
  "$10M – $50M":  50_000_000,
  "Más de $50M":  Infinity,
};

function scoreEmpresa(licit, empresa) {
  if (!empresa) return null;
  const texto = `${licit.titulo} ${licit.dependencia} ${licit.tipo} ${licit.modalidad}`.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
  let score = 0;

  // 1. Sector coincide con tipo de licitación (+30)
  const kws = (SECTOR_KW[empresa.sector] || []).map(k =>
    k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
  const sectorHits = kws.filter(k => texto.includes(k)).length;
  if (sectorHits >= 3) score += 30;
  else if (sectorHits === 2) score += 22;
  else if (sectorHits === 1) score += 14;

  // 2. Certificaciones relevantes (+20)
  const certTokens = (empresa.certificaciones || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[\s,;.]+/).filter(t => t.length > 3);
  const certHits = certTokens.filter(t => texto.includes(t)).length;
  if (certHits >= 2) score += 20;
  else if (certHits === 1) score += 12;

  // 3. Experiencia en licitaciones similares (+20)
  const expTokens = (empresa.experiencia || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[\s,;.]+/).filter(t => t.length > 4);
  const expHits = expTokens.filter(t => texto.includes(t)).length;
  if (expHits >= 2) score += 20;
  else if (expHits === 1) score += 12;

  // 4. Facturación suficiente para el monto (+15)
  const montoNum = typeof licit.monto === "number" ? licit.monto : null;
  const tope = FACTURACION_TOPES[empresa.facturacion] ?? 0;
  if (montoNum !== null) {
    if (tope >= montoNum) score += 15;
  } else {
    score += 6; // monto desconocido → crédito parcial
  }

  // 5. Capacidades técnicas relacionadas (+15)
  const capTokens = (empresa.capacidades || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[\s,;.]+/).filter(t => t.length > 4);
  const capHits = capTokens.filter(t => texto.includes(t)).length;
  if (capHits >= 2) score += 15;
  else if (capHits === 1) score += 9;

  return Math.min(100, Math.max(0, Math.round(score)));
}

function scoreColor(s) {
  if (s === null) return "var(--ink3)";
  return s >= 70 ? "var(--green)" : s >= 45 ? "var(--yellow)" : "var(--red)";
}

// ─── DISTANCIA (Sonora) ───────────────────────────────────────────────────────
const CIUDADES_GEO = {
  "hermosillo":            [29.0729, -110.9559],
  "nogales":               [31.3130, -110.9381],
  "ciudad obregon":        [27.4867, -109.9307],
  "cajeme":                [27.4867, -109.9307],
  "navojoa":               [27.0869, -109.4422],
  "guaymas":               [27.9216, -110.8976],
  "empalme":               [27.9574, -110.8123],
  "san luis rio colorado": [32.4588, -114.7748],
  "agua prieta":           [31.3267, -109.5560],
  "cananea":               [30.8667, -110.2833],
  "caborca":               [30.7111, -112.1449],
  "santa ana":             [30.5344, -111.1218],
  "magdalena":             [30.6268, -110.9592],
  "imuris":                [30.7833, -110.8500],
  "moctezuma":             [29.8000, -109.6667],
  "sahuaripa":             [29.0500, -109.2333],
  "ures":                  [29.4361, -110.3970],
  "huatabampo":            [26.8139, -109.6400],
  "alamos":                [27.0167, -108.9333],
  "nacozari":              [30.3833, -109.6833],
  "obregon":               [27.4867, -109.9307],
  "puerto penasco":        [31.3167, -113.5333],
  "pitiquito":             [30.6667, -112.0500],
  "altar":                 [30.7167, -111.8500],
  "sonora":                [29.0729, -110.9559], // estado → capital
};

function _norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function extractCiudad(dependencia) {
  if (!dependencia) return null;
  const dep = _norm(dependencia);

  // Match por nombre de ciudad (más largos primero para evitar falsos positivos)
  const sorted = Object.keys(CIUDADES_GEO).sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (dep.includes(_norm(c))) return c;
  }

  // Patrones de municipio / ayuntamiento
  const m = dep.match(/(?:municipio|ayuntamiento|h\.?\s*ayuntamiento)\s+de\s+([a-z\s]+?)(?:\s|,|$)/);
  if (m) {
    const nombre = m[1].trim();
    for (const c of sorted) {
      if (_norm(c) === nombre || nombre.startsWith(_norm(c))) return c;
    }
  }

  // Organismos estatales → capital
  if (/secretaria|gobierno del estado|isssteson|coespreson|imss|issste|sepen|conagua|comision estatal|instituto sonorense/.test(dep)) {
    return "hermosillo";
  }

  return null;
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Geocodifica un CP mexicano vía Nominatim (sin API key)
async function geocodeCPMexico(cp) {
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(cp)}&country=MX&format=json&limit=1&addressdetails=1`;
  const res = await fetch(url, {
    headers: { "Accept-Language": "es", "User-Agent": "LicitaIA/1.0" },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  if (!data.length) return null;
  const d = data[0];
  const ciudad = d.address?.city || d.address?.town || d.address?.village || d.address?.county || "";
  const estado = d.address?.state || "";
  return {
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    ciudadResuelta: [ciudad, estado].filter(Boolean).join(", "),
  };
}

function calcDistanciaKm(empresa, ciudadDep) {
  // Empresa: usa lat/lon del CP geocodificado, si existe
  const c1 = (empresa?.latEmpresa && empresa?.lonEmpresa)
    ? [empresa.latEmpresa, empresa.lonEmpresa]
    : CIUDADES_GEO[_norm(empresa?.ciudad || "")]; // fallback a ciudad guardada
  const c2 = CIUDADES_GEO[_norm(ciudadDep)];
  if (!c1 || !c2) return null;
  return haversineKm(c1, c2);
}

function distanciaCategoria(km, empresa) {
  if (km === null) return null;
  const cerca = Number(empresa?.distanciaCerca) || 15;
  const media = Number(empresa?.distanciaMedia) || 25;
  const lejos = Number(empresa?.distanciaLejos) || 50;
  if (km <= cerca) return "cerca";
  if (km <= media) return "media";
  if (km <= lejos) return "lejos";
  return "muyLejos"; // fuera del rango configurado
}

const TIPOS = [
  { id:"viabilidad", icon:"🎯", label:"Viabilidad",   desc:"¿Vale la pena presentarse? Score + veredicto." },
  { id:"clausulas",  icon:"📌", label:"Cláusulas",    desc:"Cláusulas clave con fuente exacta." },
  { id:"plazos",     icon:"📅", label:"Plazos",       desc:"Fechas críticas del pliego." },
  { id:"financiero", icon:"💰", label:"Financiero",   desc:"Garantías y penalidades." },
];
const SECTORES    = ["Tecnología","Construcción","Consultoría","Salud","Educación","Logística","Servicios","Manufactura","Seguridad","Otro"];
const FACTURACION = ["Menos de $500K","$500K – $2M","$2M – $10M","$10M – $50M","Más de $50M"];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&family=Outfit:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0c0f;--paper:#111318;--surface:#181c22;--surface2:#1e2330;
  --ink:#e8eaf0;--ink2:#8892a4;--ink3:#4a5568;
  --blue:#3b82f6;--blue-bg:rgba(59,130,246,0.12);--blue-border:rgba(59,130,246,0.25);
  --green:#10b981;--yellow:#f59e0b;--red:#ef4444;
  --border:#252b38;--border2:#2d3548;--shadow:0 2px 16px rgba(0,0,0,0.35);
  --display:'Fraunces',Georgia,serif;--mono:'IBM Plex Mono',monospace;--sans:'Outfit',sans-serif;
}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
.shell{display:grid;grid-template-columns:272px 1fr;min-height:100vh}
.sidebar{background:var(--paper);border-right:1px solid var(--border);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.logo-wrap{padding:24px 20px 18px;border-bottom:1px solid var(--border)}
.logo{font-family:var(--display);font-size:21px;font-weight:700;letter-spacing:-0.5px}
.logo em{color:var(--blue);font-style:normal}
.logo-sub{font-family:var(--mono);font-size:10px;color:var(--ink3);margin-top:3px;letter-spacing:1px;text-transform:uppercase}
nav{padding:14px 10px;flex:1}
.nb{width:100%;display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:8px;border:none;background:none;cursor:pointer;font-family:var(--sans);font-size:13.5px;font-weight:500;color:var(--ink2);transition:all 0.15s;text-align:left;margin-bottom:2px}
.nb:hover{background:var(--blue-bg);color:var(--ink)}
.nb.on{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.nb-badge{margin-left:auto;background:var(--blue);color:white;font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:10px}
.emp-mini{margin:10px;background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:10px;padding:12px}
.emp-name{font-family:var(--display);font-size:13px;font-weight:600;margin-bottom:3px}
.emp-meta{font-family:var(--mono);font-size:10px;color:var(--ink3);line-height:1.6}
.no-emp{font-size:12px;color:var(--ink3);text-align:center;padding:14px 10px}
.no-emp span{color:var(--blue);cursor:pointer;text-decoration:underline;font-weight:600}
.user-info{margin:10px;padding:10px 12px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.user-email{font-family:var(--mono);font-size:10px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.btn-signout{background:transparent;border:1px solid var(--border2);color:var(--ink3);font-family:var(--mono);font-size:10px;padding:4px 8px;border-radius:5px;cursor:pointer;transition:all 0.15s;white-space:nowrap}
.btn-signout:hover{border-color:var(--red);color:var(--red)}
.main{overflow-y:auto;background:var(--bg)}
.page{max-width:880px;margin:0 auto;padding:36px 28px}
.pg-title{font-family:var(--display);font-size:28px;font-weight:700;letter-spacing:-0.5px;margin-bottom:4px}
.pg-sub{font-size:13.5px;color:var(--ink3);margin-bottom:28px;line-height:1.5}
.card{background:var(--paper);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:18px;box-shadow:var(--shadow)}
.ct{font-family:var(--display);font-size:16px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:7px}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ff{grid-column:1/-1}
.fl{display:flex;flex-direction:column;gap:5px}
.lbl{font-family:var(--mono);font-size:10px;font-weight:500;color:var(--ink3);text-transform:uppercase;letter-spacing:0.8px}
.inp,.sel,.ta{background:var(--surface);border:1px solid var(--border2);border-radius:7px;padding:9px 12px;font-family:var(--sans);font-size:13.5px;color:var(--ink);outline:none;transition:border-color 0.15s;width:100%}
.ta{resize:vertical;min-height:72px;line-height:1.5}
.inp:focus,.sel:focus,.ta:focus{border-color:var(--blue)}
.sel{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%234a5568' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px}
.btn{display:inline-flex;align-items:center;gap:7px;padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-family:var(--sans);font-weight:600;font-size:13.5px;transition:all 0.2s}
.btn-blue{background:var(--blue);color:white}
.btn-blue:hover:not(:disabled){background:#2563eb;transform:translateY(-1px);box-shadow:0 4px 14px rgba(59,130,246,0.35)}
.btn-blue:disabled{opacity:0.4;cursor:not-allowed;transform:none}
.btn-ghost{background:transparent;color:var(--ink2);border:1px solid var(--border2)}
.btn-ghost:hover{background:var(--surface)}
.btn-sm{padding:6px 13px;font-size:12px}
.btn-row{display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}
.btn-danger{background:transparent;color:var(--red);border:1px solid rgba(239,68,68,0.2);font-size:12px;padding:6px 12px;border-radius:7px;cursor:pointer;font-family:var(--sans);transition:background 0.15s}
.btn-danger:hover{background:rgba(239,68,68,0.08)}
.upload-zone{border:2px dashed var(--border2);border-radius:12px;padding:44px 24px;text-align:center;cursor:pointer;transition:all 0.2s;background:var(--bg)}
.upload-zone:hover,.upload-zone.drag{border-color:var(--blue);background:var(--blue-bg)}
.uz-icon{font-size:38px;margin-bottom:10px}
.uz-title{font-family:var(--display);font-size:18px;font-weight:600;margin-bottom:5px}
.uz-sub{font-size:13px;color:var(--ink2)}
.uz-fmt{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:8px;display:inline-block;padding:3px 10px;border-radius:4px;border:1px solid var(--border)}
.file-row{display:flex;align-items:center;gap:12px;background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:10px;padding:13px 15px;margin-bottom:20px}
.fi-name{font-weight:600;font-size:14px;margin-bottom:2px}
.fi-meta{font-family:var(--mono);font-size:11px;color:var(--ink3)}
.tipo-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:18px}
.tipo-opt{border:1.5px solid var(--border);border-radius:10px;padding:13px;cursor:pointer;transition:all 0.15s;text-align:left;background:var(--surface);width:100%}
.tipo-opt:hover{border-color:var(--blue);background:var(--blue-bg)}
.tipo-opt.sel{border-color:var(--blue);background:var(--blue-bg)}
.to-icon{font-size:18px;margin-bottom:5px}
.to-title{font-family:var(--display);font-size:13px;font-weight:600;color:var(--ink);margin-bottom:2px}
.to-desc{font-size:11px;color:var(--ink3);line-height:1.4}
.stepper{display:flex;align-items:center;margin-bottom:24px}
.step{display:flex;align-items:center;gap:7px}
.sn{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:11px;font-weight:500;border:1.5px solid;flex-shrink:0}
.step.done .sn,.step.active .sn{background:var(--blue);border-color:var(--blue);color:white}
.step.pending .sn{background:transparent;border-color:var(--border2);color:var(--ink3)}
.sl{font-size:12px;font-weight:500;white-space:nowrap}
.step.active .sl{color:var(--ink);font-weight:600}
.step.pending .sl,.step.done .sl{color:var(--ink3)}
.sline{flex:1;height:1px;background:var(--border);margin:0 8px}
.sline.done{background:var(--blue)}
.loading{text-align:center;padding:52px 24px}
.spinner{width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.ld-msg{font-family:var(--display);font-size:16px;color:var(--ink2);margin-bottom:5px}
.ld-sub{font-family:var(--mono);font-size:11px;color:var(--ink3)}
.err-box{background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:9px;padding:12px 15px;font-size:13px;color:var(--red);margin-bottom:14px}
.warn-banner{background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:9px;padding:12px 16px;margin-bottom:22px;display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--ink2)}
.validation-warn{background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--yellow)}
.result-wrap{animation:fadeUp 0.4s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.rh{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.rtitle{font-family:var(--display);font-size:20px;font-weight:700}
.rmeta{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:3px}
.vd{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:8px;font-weight:700;font-size:14px;font-family:var(--display)}
.vd.GO{background:rgba(16,185,129,0.12);border:1.5px solid rgba(16,185,129,0.3);color:var(--green)}
.vd.NOGO{background:rgba(239,68,68,0.1);border:1.5px solid rgba(239,68,68,0.3);color:var(--red)}
.vd.REVISAR{background:rgba(245,158,11,0.1);border:1.5px solid rgba(245,158,11,0.3);color:var(--yellow)}
.score-row{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.sc-num{font-family:var(--display);font-size:46px;font-weight:700;line-height:1}
.sc-bar-wrap{flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden}
.sc-bar{height:100%;border-radius:4px;transition:width 0.9s ease}
.sc-reason{font-size:12px;color:var(--ink3);margin-top:5px}
.sec{margin-bottom:20px}
.sec-lbl{font-family:var(--mono);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px;color:var(--ink3);margin-bottom:10px;display:flex;align-items:center;gap:7px}
.sec-lbl::after{content:'';flex:1;height:1px;background:var(--border)}
.tw{overflow-x:auto;border-radius:8px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:var(--surface);padding:8px 13px;text-align:left;font-family:var(--mono);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink3);border-bottom:1px solid var(--border)}
td{padding:8px 13px;border-bottom:1px solid var(--border);color:var(--ink);vertical-align:top;line-height:1.4}
tr:last-child td{border-bottom:none}
tr:nth-child(even) td{background:rgba(255,255,255,0.02)}
.trace-box{margin-top:6px;background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--blue);border-radius:5px;padding:8px 10px}
.trace-fuente{font-family:var(--mono);font-size:10px;color:var(--blue);margin-bottom:4px;font-weight:500}
.trace-texto{font-size:11px;color:var(--ink3);line-height:1.5;font-style:italic}
.checklist{display:flex;flex-direction:column;gap:5px}
.ci{border-radius:8px;font-size:13px;line-height:1.4;overflow:hidden}
.ci-header{display:flex;align-items:flex-start;gap:9px;padding:9px 11px}
.ci.ok .ci-header{background:rgba(16,185,129,0.07)}
.ci.warn .ci-header{background:rgba(245,158,11,0.07)}
.ci.bad .ci-header{background:rgba(239,68,68,0.07)}
.ci-dot{font-size:13px;flex-shrink:0;margin-top:1px}
.ci-trace{padding:0 11px 9px 34px}
.ci.ok .ci-trace{background:rgba(16,185,129,0.03)}
.ci.warn .ci-trace{background:rgba(245,158,11,0.03)}
.ci.bad .ci-trace{background:rgba(239,68,68,0.03)}
.tag{font-family:var(--mono);font-size:11px;padding:3px 9px;border-radius:5px;border:1px solid;display:inline-block}
.tag.ok{background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.25);color:var(--green)}
.tag.warn{background:rgba(245,158,11,0.1);border-color:rgba(245,158,11,0.25);color:var(--yellow)}
.tag.bad{background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.25);color:var(--red)}
.tag.neutral{background:var(--surface);border-color:var(--border2);color:var(--ink2)}
.prose-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:15px;font-size:13.5px;line-height:1.7;color:var(--ink2)}
.hi{display:flex;align-items:flex-start;gap:12px;padding:13px;border:1px solid var(--border);border-radius:10px;background:var(--paper);margin-bottom:8px;cursor:pointer;transition:all 0.15s}
.hi:hover{border-color:var(--blue);background:var(--blue-bg)}
.hb{padding:4px 9px;border-radius:5px;font-family:var(--mono);font-size:11px;font-weight:500;flex-shrink:0;white-space:nowrap}
.hb.GO{background:rgba(16,185,129,0.12);color:var(--green)}
.hb.NOGO{background:rgba(239,68,68,0.1);color:var(--red)}
.hb.REVISAR{background:rgba(245,158,11,0.1);color:var(--yellow)}
.hb.generic{background:var(--blue-bg);color:var(--blue)}
.hi-name{font-weight:600;font-size:13.5px;margin-bottom:2px}
.hi-meta{font-family:var(--mono);font-size:11px;color:var(--ink3)}
.ctx-pill{display:inline-flex;align-items:center;gap:6px;background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:20px;padding:4px 12px;font-family:var(--mono);font-size:11px;color:var(--blue);margin-bottom:20px}
.toast{position:fixed;bottom:22px;right:22px;background:var(--surface2);color:var(--ink);padding:11px 16px;border-radius:9px;font-size:13.5px;font-weight:500;border:1px solid var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.5);animation:slideIn 0.3s ease;z-index:999;display:flex;align-items:center;gap:7px}
@keyframes slideIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}
.empty-state{text-align:center;padding:56px 20px;color:var(--ink3)}
.empty-state .ei{font-size:38px;margin-bottom:13px}
.empty-state .et{font-family:var(--display);font-size:18px;color:var(--ink2);margin-bottom:6px}

/* ── DASHBOARD LICITACIONES ── */
.dash-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.dash-filters{display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap}
.dash-sel{background:var(--surface);border:1px solid var(--border2);border-radius:7px;padding:7px 10px;font-family:var(--sans);font-size:12.5px;color:var(--ink);outline:none;transition:border-color 0.15s;height:34px}
.dash-sel:focus{border-color:var(--blue)}
.dash-inp{background:var(--surface);border:1px solid var(--border2);border-radius:7px;padding:7px 10px;font-family:var(--sans);font-size:12.5px;color:var(--ink);outline:none;transition:border-color 0.15s;width:148px;height:34px}
.dash-inp:focus{border-color:var(--blue)}
.dash-rate{font-family:var(--mono);font-size:11px;color:var(--ink3);white-space:nowrap}
.dash-last{font-family:var(--mono);font-size:10px;color:var(--ink3)}
.lic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}
.lic-card{background:var(--paper);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;transition:border-color 0.15s;cursor:default}
.lic-card:hover{border-color:var(--blue-border)}
.lic-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.lic-num{font-family:var(--mono);font-size:10px;color:var(--ink3);white-space:nowrap;padding-top:2px}
.lic-num-wrap{display:flex;align-items:center;gap:4px;flex-shrink:0}
.lic-copy{background:none;border:none;padding:2px 3px;cursor:pointer;color:var(--ink3);border-radius:4px;line-height:1;font-size:11px;opacity:0.55;transition:opacity 0.15s}
.lic-copy:hover{opacity:1;background:var(--surface)}
.lic-actions{display:flex;align-items:center;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--border);margin-top:2px}
.lic-portal-link{font-family:var(--mono);font-size:10px;color:var(--blue);text-decoration:none;padding:3px 8px;border:1px solid var(--blue-border);border-radius:5px;transition:background 0.15s}
.lic-portal-link:hover{background:rgba(59,130,246,0.06)}
.lic-titulo{font-family:var(--display);font-size:14px;font-weight:600;line-height:1.4;color:var(--ink);flex:1}
.lic-dep{font-family:var(--mono);font-size:11px;color:var(--blue);margin-top:2px}
.lic-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.lic-badge{font-family:var(--mono);font-size:10px;padding:3px 8px;border-radius:5px;border:1px solid;white-space:nowrap}
.lic-badge.vigente{background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.25);color:var(--green)}
.lic-badge.seguimiento{background:rgba(234,179,8,0.1);border-color:rgba(234,179,8,0.3);color:#b45309}
.lic-badge.adjudicada{background:rgba(99,102,241,0.1);border-color:rgba(99,102,241,0.25);color:#4f46e5}
.lic-badge.otro{background:var(--surface);border-color:var(--border2);color:var(--ink3)}
.lic-score-row{display:flex;align-items:center;gap:8px;margin-top:4px;padding-top:10px;border-top:1px solid var(--border)}
.lic-score-num{font-family:var(--display);font-size:22px;font-weight:700;line-height:1;min-width:34px}
.lic-score-bar-wrap{flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden}
.lic-score-bar{height:100%;border-radius:3px;transition:width 0.7s ease}
.lic-score-lbl{font-family:var(--mono);font-size:10px;color:var(--ink3)}
.lic-dist{font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:5px;border:1px solid;white-space:nowrap}
.lic-dist.cerca{background:rgba(16,185,129,0.08);border-color:rgba(16,185,129,0.2);color:var(--green)}
.lic-dist.media{background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.2);color:#d97706}
.lic-dist.lejos{background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:var(--red)}
.dash-score-hint{font-family:var(--mono);font-size:11px;color:var(--ink3);padding:10px 14px;background:var(--surface);border:1px solid var(--border2);border-radius:8px;margin-bottom:14px}
.lic-date{font-family:var(--mono);font-size:10px;color:var(--ink3);display:flex;align-items:center;gap:4px}
.dash-empty{text-align:center;padding:60px 20px;color:var(--ink3)}
.dash-empty .de-icon{font-size:40px;margin-bottom:14px}
.dash-empty .de-title{font-family:var(--display);font-size:18px;color:var(--ink2);margin-bottom:6px}
.dash-empty .de-sub{font-size:13px;line-height:1.6}
.dash-fuente{font-family:var(--mono);font-size:10px;color:var(--ink3);padding:4px 10px;background:var(--surface);border:1px solid var(--border);border-radius:5px}
.rate-warn{background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:9px;padding:11px 15px;font-size:13px;color:var(--yellow);margin-bottom:18px;display:flex;align-items:center;gap:8px}
.lic-anticipo{font-family:var(--mono);font-size:10px;color:var(--ink2)}
.lic-anticipo-nd{color:var(--ink3);font-style:italic}

/* ── LOGIN ── */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:20px}
.login-card{background:var(--paper);border:1px solid var(--border);border-radius:16px;padding:40px 36px;width:100%;max-width:400px;box-shadow:var(--shadow)}
.login-logo{font-family:var(--display);font-size:26px;font-weight:700;margin-bottom:4px;text-align:center}
.login-logo em{color:var(--blue);font-style:normal}
.login-sub{font-family:var(--mono);font-size:11px;color:var(--ink3);text-align:center;margin-bottom:32px;letter-spacing:1px;text-transform:uppercase}
.login-title{font-family:var(--display);font-size:18px;font-weight:600;margin-bottom:20px}
.login-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.login-input{background:var(--surface);border:1px solid var(--border2);border-radius:8px;padding:11px 14px;font-family:var(--sans);font-size:14px;color:var(--ink);outline:none;transition:border-color 0.15s;width:100%}
.login-input:focus{border-color:var(--blue)}
.login-btn{width:100%;background:var(--blue);color:white;border:none;border-radius:8px;padding:12px;font-family:var(--sans);font-weight:600;font-size:14px;cursor:pointer;transition:all 0.2s;margin-top:6px}
.login-btn:hover:not(:disabled){background:#2563eb;transform:translateY(-1px)}
.login-btn:disabled{opacity:0.45;cursor:not-allowed;transform:none}
.login-toggle{text-align:center;margin-top:16px;font-size:13px;color:var(--ink3)}
.login-toggle span{color:var(--blue);cursor:pointer;font-weight:600}
.login-err{background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:7px;padding:10px 12px;font-size:12.5px;color:var(--red);margin-bottom:14px}
.login-ok{background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:7px;padding:10px 12px;font-size:12.5px;color:var(--green);margin-bottom:14px}

/* ── REVISAR PROPUESTA ── */
.rev-upload-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
@media(max-width:640px){.rev-upload-grid{grid-template-columns:1fr}}
.rev-zone{border:2px dashed var(--border2);border-radius:12px;padding:20px 16px;text-align:center;cursor:pointer;transition:all 0.2s;background:var(--surface);min-height:130px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
.rev-zone:hover,.rev-zone.drag{border-color:var(--blue);background:var(--blue-bg)}
.rev-zone.loaded{border-color:var(--green);border-style:solid;background:rgba(16,185,129,0.04)}
.rev-zone-icon{font-size:26px}
.rev-zone-label{font-family:var(--display);font-size:13px;font-weight:600;color:var(--ink)}
.rev-zone-sub{font-family:var(--mono);font-size:10px;color:var(--ink3)}
.rev-zone-file{font-family:var(--mono);font-size:11px;color:var(--green);font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
.rev-zone-clear{background:none;border:none;color:var(--ink3);font-size:11px;cursor:pointer;padding:2px 6px;border-radius:4px;margin-top:2px}
.rev-zone-clear:hover{color:var(--red)}
.rev-estado{display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:12px;margin-bottom:20px;border:1.5px solid}
.rev-estado.APROBADO{background:rgba(16,185,129,0.08);border-color:rgba(16,185,129,0.25)}
.rev-estado.EN_RIESGO{background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.25)}
.rev-estado.INCOMPLETO{background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.25)}
.rev-estado-icon{font-size:24px;flex-shrink:0}
.rev-estado-label{font-family:var(--display);font-size:16px;font-weight:700}
.rev-estado.APROBADO .rev-estado-label{color:var(--green)}
.rev-estado.EN_RIESGO .rev-estado-label{color:var(--yellow)}
.rev-estado.INCOMPLETO .rev-estado-label{color:var(--red)}
.rev-estado-sub{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:2px}
.rev-score-badge{margin-left:auto;font-family:var(--display);font-size:28px;font-weight:700;flex-shrink:0}
.rev-score-badge span{font-family:var(--mono);font-size:11px;color:var(--ink3);font-weight:400;margin-left:2px}
.rev-sec{margin-bottom:22px}
.rev-sec-lbl{font-family:var(--mono);font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.rev-checklist{display:flex;flex-direction:column;gap:4px}
.rev-req{border-radius:9px;overflow:hidden;font-size:13px}
.rev-req-head{display:flex;align-items:flex-start;gap:10px;padding:9px 12px}
.rev-req.CUMPLIDO .rev-req-head{background:rgba(16,185,129,0.07)}
.rev-req.PARCIAL  .rev-req-head{background:rgba(245,158,11,0.07)}
.rev-req.FALTANTE .rev-req-head{background:rgba(239,68,68,0.07)}
.rev-req-dot{font-size:13px;flex-shrink:0;margin-top:1px}
.rev-req-body{flex:1}
.rev-req-nombre{font-weight:600;font-size:13px;color:var(--ink);line-height:1.35}
.rev-req-desc{font-size:12px;color:var(--ink3);margin-top:3px;line-height:1.4}
.rev-req-tag{font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid;white-space:nowrap;flex-shrink:0;align-self:flex-start;margin-top:2px}
.rev-req-tag.CUMPLIDO{background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.25);color:var(--green)}
.rev-req-tag.PARCIAL{background:rgba(245,158,11,0.1);border-color:rgba(245,158,11,0.25);color:var(--yellow)}
.rev-req-tag.FALTANTE{background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.25);color:var(--red)}
.rev-req-detail{padding:6px 12px 9px 35px;font-size:11.5px;line-height:1.5;color:var(--ink2)}
.rev-req.CUMPLIDO .rev-req-detail{background:rgba(16,185,129,0.03)}
.rev-req.PARCIAL  .rev-req-detail{background:rgba(245,158,11,0.03)}
.rev-req.FALTANTE .rev-req-detail{background:rgba(239,68,68,0.03)}
.rev-req-detail-row{display:flex;gap:5px;margin-bottom:2px}
.rev-req-detail-key{font-family:var(--mono);font-size:10px;color:var(--ink3);flex-shrink:0;width:70px}
.rev-list{display:flex;flex-direction:column;gap:5px}
.rev-list-item{display:flex;gap:9px;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:13px;line-height:1.4;color:var(--ink2)}
.rev-list-item.error{background:rgba(239,68,68,0.05);border-color:rgba(239,68,68,0.15)}
.rev-list-item.rec{background:rgba(59,130,246,0.04);border-color:rgba(59,130,246,0.12)}
.rev-list-icon{flex-shrink:0;font-size:13px}
.rev-progress{margin-bottom:12px}
.rev-progress-bar{height:6px;background:var(--border);border-radius:4px;overflow:hidden;display:flex;gap:1px}
.rev-progress-seg.ok{background:var(--green)}
.rev-progress-seg.warn{background:var(--yellow)}
.rev-progress-seg.bad{background:var(--red)}
.rev-progress-stats{display:flex;gap:14px;margin-top:8px}
.rev-stat{font-family:var(--mono);font-size:11px;display:flex;align-items:center;gap:4px}
`;

// ─── TRACE COMPONENT ─────────────────────────────────────────────────────────
function Trace({ fuente, texto }) {
  return (
    <div className="trace-box">
      <div className="trace-fuente">📍 {fuente || "Fuente no identificada claramente"}</div>
      <div className="trace-texto">"{texto || "Fuente no identificada claramente"}"</div>
    </div>
  );
}

// ─── RESULT COMPONENT ────────────────────────────────────────────────────────
function UnifiedResult({ data }) {
  if (!data) return null;
  const vd = data.veredicto;
  const sc = data.score ?? null;
  const conclusionText = data.conclusion || "";
  const recoMatch = conclusionText.match(/Recomendación:\s*(Participar con precaución|No participar|Participar)/i);
  const recoLabel = recoMatch ? recoMatch[0] : null;
  const conclusionBody = recoLabel ? conclusionText.slice(0, conclusionText.indexOf(recoLabel)).trim() : conclusionText;

  return (
    <div className="result-wrap">
      <div className="rh">
        <div>
          <div className="rtitle">{data.licitacion?.nombre || "Resultado"}</div>
          <div className="rmeta">{data.licitacion?.organismo}{data.licitacion?.monto && data.licitacion.monto !== "—" && ` · ${data.licitacion.monto}`}</div>
        </div>
        {vd && <div className={`vd ${vd}`}>{vd==="GO"?"✓ PRESENTARSE":vd==="NOGO"?"✗ NO PRESENTARSE":"⚠ REVISAR"}</div>}
      </div>

      {sc !== null && (
        <div className="score-row">
          <div>
            <div className="sc-num" style={{color:scoreCol(sc)}}>{sc}</div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--ink3)"}}>/ 100</div>
          </div>
          <div style={{flex:1}}>
            <div className="sc-bar-wrap"><div className="sc-bar" style={{width:`${sc}%`,background:scoreCol(sc)}}/></div>
            <div className="sc-reason">{data.score_razon}</div>
          </div>
        </div>
      )}

      <div className="sec">
        <div className="sec-lbl">📋 Resumen</div>
        <div className="prose-box">{data.resumen || "Sin resumen."}</div>
      </div>

      {data.licitacion && (data.licitacion.objeto || data.licitacion.plazo_presentacion) && (
        <div className="sec">
          <div className="sec-lbl">📄 Datos del Pliego</div>
          <div className="tw">
            <table><tbody>
              {[["Objeto",data.licitacion.objeto],["Plazo presentación",data.licitacion.plazo_presentacion],["Plazo ejecución",data.licitacion.plazo_ejecucion],["Presupuesto",data.licitacion.monto]]
                .filter(([,v])=>v&&v!=="—").map(([k,v])=>(
                <tr key={k}>
                  <td style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--ink3)",width:170}}>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </div>
      )}

      <div className="sec">
        <div className="sec-lbl">⚙️ Requisitos — con Trazabilidad</div>
        {data.requisitos?.length > 0 ? (
          <div className="checklist">
            {data.requisitos.map((r,i)=>{
              const cls = r.estado==="OK"?"ok":r.estado==="NOGO"?"bad":"warn";
              return (
                <div key={i} className={`ci ${cls}`}>
                  <div className="ci-header">
                    <span className="ci-dot">{r.estado==="OK"?"✓":r.estado==="NOGO"?"✗":"⚠"}</span>
                    <div style={{flex:1}}>
                      <strong style={{fontSize:13}}>{r.requisito}</strong>
                      {r.nota&&<><br/><span style={{fontSize:12,color:"var(--ink3)"}}>{r.nota}</span></>}
                    </div>
                    <span className={`tag ${cls}`}>{r.estado}</span>
                  </div>
                  <div className="ci-trace"><Trace fuente={r.fuente} texto={r.texto_original}/></div>
                </div>
              );
            })}
          </div>
        ) : <div style={{color:"var(--ink3)",fontSize:13,padding:"10px 0"}}>No se identificaron requisitos.</div>}
      </div>

      <div className="sec">
        <div className="sec-lbl">⚠️ Riesgos</div>
        {data.riesgos?.length > 0 ? (
          <div className="checklist">
            {data.riesgos.map((r,i)=>(
              <div key={i} className="ci warn">
                <div className="ci-header">
                  <span className="ci-dot">⚠</span>
                  <span style={{fontSize:13,flex:1}}>{typeof r==="string"?r:r.descripcion||JSON.stringify(r)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : <div style={{color:"var(--ink3)",fontSize:13,padding:"10px 0"}}>No se identificaron riesgos críticos.</div>}
      </div>

      <div className="sec">
        <div className="sec-lbl">🎯 Conclusión</div>
        <div className="prose-box">
          {conclusionBody && <p style={{marginBottom:recoLabel?12:0}}>{conclusionBody}</p>}
          {recoLabel && (
            <div style={{
              display:"inline-flex",alignItems:"center",gap:8,
              background:vd==="GO"?"rgba(16,185,129,0.12)":vd==="NOGO"?"rgba(239,68,68,0.1)":"rgba(245,158,11,0.1)",
              border:`1.5px solid ${vd==="GO"?"rgba(16,185,129,0.3)":vd==="NOGO"?"rgba(239,68,68,0.3)":"rgba(245,158,11,0.3)"}`,
              color:vd==="GO"?"var(--green)":vd==="NOGO"?"var(--red)":"var(--yellow)",
              borderRadius:8,padding:"8px 14px",fontFamily:"var(--display)",fontWeight:700,fontSize:14,
            }}>
              {vd==="GO"?"✓":vd==="NOGO"?"✗":"⚠"} {recoLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultRenderer({ data, warnings }) {
  if (!data) return null;
  return (
    <>
      {warnings?.length > 0 && <div className="validation-warn">⚠ {warnings.join(" · ")}</div>}
      <UnifiedResult data={data}/>
    </>
  );
}

// ─── REVISION RESULT COMPONENT ────────────────────────────────────────────────
function RevisionResult({ data }) {
  if (!data) return null;
  const sc = data.score ?? null;
  const scColor = sc !== null ? (sc >= 80 ? "var(--green)" : sc >= 50 ? "var(--yellow)" : "var(--red)") : "var(--ink3)";
  const estadoIcon = { APROBADO: "✅", EN_RIESGO: "⚠️", INCOMPLETO: "❌" }[data.estado] || "❓";
  const estadoText = { APROBADO: "Propuesta Aprobada", EN_RIESGO: "Propuesta en Riesgo", INCOMPLETO: "Propuesta Incompleta" }[data.estado] || data.estado;

  const cumplidos = (data.checklist || []).filter(r => r.estado === "CUMPLIDO").length;
  const parciales  = (data.checklist || []).filter(r => r.estado === "PARCIAL").length;
  const faltantes  = (data.checklist || []).filter(r => r.estado === "FALTANTE").length;
  const total = cumplidos + parciales + faltantes;

  return (
    <div className="result-wrap">
      {/* Estado general */}
      <div className={`rev-estado ${data.estado}`}>
        <div className="rev-estado-icon">{estadoIcon}</div>
        <div>
          <div className="rev-estado-label">{estadoText}</div>
          {data.licitacion?.nombre && data.licitacion.nombre !== "—" && (
            <div className="rev-estado-sub">{data.licitacion.nombre}{data.licitacion.organismo && data.licitacion.organismo !== "—" ? ` · ${data.licitacion.organismo}` : ""}</div>
          )}
        </div>
        {sc !== null && (
          <div className="rev-score-badge" style={{ color: scColor }}>
            {sc}<span>/ 100</span>
          </div>
        )}
      </div>

      {/* Resumen */}
      <div className="rev-sec">
        <div className="rev-sec-lbl">📋 Resumen ejecutivo</div>
        <div className="prose-box">{data.resumen}</div>
      </div>

      {/* Progress bar + stats */}
      {total > 0 && (
        <div className="rev-sec">
          <div className="rev-sec-lbl">📊 Cumplimiento de requisitos</div>
          <div className="rev-progress">
            <div className="rev-progress-bar">
              {cumplidos > 0 && <div className="rev-progress-seg ok" style={{ flex: cumplidos }}/>}
              {parciales > 0 && <div className="rev-progress-seg warn" style={{ flex: parciales }}/>}
              {faltantes > 0 && <div className="rev-progress-seg bad" style={{ flex: faltantes }}/>}
            </div>
            <div className="rev-progress-stats">
              <div className="rev-stat"><span style={{color:"var(--green)"}}>✓</span> {cumplidos} cumplidos</div>
              <div className="rev-stat"><span style={{color:"var(--yellow)"}}>⚠</span> {parciales} parciales</div>
              <div className="rev-stat"><span style={{color:"var(--red)"}}>✗</span> {faltantes} faltantes</div>
              <div className="rev-stat" style={{color:"var(--ink3)"}}>de {total} requisitos</div>
            </div>
          </div>
        </div>
      )}

      {/* Checklist */}
      {data.checklist?.length > 0 && (
        <div className="rev-sec">
          <div className="rev-sec-lbl">☑️ Checklist de requisitos</div>
          <div className="rev-checklist">
            {data.checklist.map((r, i) => {
              const dot = r.estado === "CUMPLIDO" ? "✓" : r.estado === "FALTANTE" ? "✗" : "⚠";
              return (
                <div key={i} className={`rev-req ${r.estado}`}>
                  <div className="rev-req-head">
                    <span className="rev-req-dot">{dot}</span>
                    <div className="rev-req-body">
                      <div className="rev-req-nombre">{r.requisito}</div>
                      {r.descripcion && <div className="rev-req-desc">{r.descripcion}</div>}
                    </div>
                    <span className={`rev-req-tag ${r.estado}`}>
                      {r.estado === "CUMPLIDO" ? "✓ Cumplido" : r.estado === "FALTANTE" ? "✗ Faltante" : "⚠ Parcial"}
                    </span>
                  </div>
                  {(r.fuente_base || r.evidencia_propuesta) && (
                    <div className="rev-req-detail">
                      {r.fuente_base && (
                        <div className="rev-req-detail-row">
                          <span className="rev-req-detail-key">📌 Bases:</span>
                          <span style={{fontStyle:"italic",color:"var(--ink3)"}}>{r.fuente_base}</span>
                        </div>
                      )}
                      {r.evidencia_propuesta && (
                        <div className="rev-req-detail-row">
                          <span className="rev-req-detail-key">📄 Propuesta:</span>
                          <span>{r.evidencia_propuesta}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Errores críticos */}
      {data.errores?.length > 0 && (
        <div className="rev-sec">
          <div className="rev-sec-lbl">🚨 Errores y faltantes críticos</div>
          <div className="rev-list">
            {data.errores.map((e, i) => (
              <div key={i} className="rev-list-item error">
                <span className="rev-list-icon">✗</span>
                <span>{e}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recomendaciones */}
      {data.recomendaciones?.length > 0 && (
        <div className="rev-sec">
          <div className="rev-sec-lbl">💡 Recomendaciones</div>
          <div className="rev-list">
            {data.recomendaciones.map((r, i) => (
              <div key={i} className="rev-list-item rec">
                <span className="rev-list-icon">→</span>
                <span>{r}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [modo, setModo]       = useState("login"); // login | registro | reset
  const [email, setEmail]     = useState("");
  const [pass, setPass]       = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [ok, setOk]           = useState("");

  const handleSubmit = async () => {
    setError(""); setOk(""); setLoading(true);
    try {
      if (modo === "login") {
        const { data, error: e } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (e) throw e;
        const { data: aprobRow } = await supabase
          .from("aprobaciones").select("aprobado").eq("email", data.user.email).maybeSingle();
        if (!aprobRow?.aprobado) {
          await supabase.auth.signOut();
          setError("Tu cuenta está en revisión. Te avisaremos cuando tengas acceso.");
          return;
        }
        onLogin(data.user);
      } else if (modo === "registro") {
        const { error: e } = await supabase.auth.signUp({ email, password: pass });
        if (e) throw e;
        setOk("✓ Cuenta creada. Revisá tu email para confirmar.");
        setModo("login");
      } else {
        const { error: e } = await supabase.auth.resetPasswordForEmail(email);
        if (e) throw e;
        setOk("✓ Te enviamos un link para restablecer tu contraseña.");
      }
    } catch (e) {
      setError(e.message || "Error. Intentá de nuevo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">Licita<em>IA</em></div>
        <div className="login-sub">Motor de Licitaciones</div>

        <div className="login-title">
          {modo==="login" ? "Iniciar sesión" : modo==="registro" ? "Crear cuenta" : "Recuperar contraseña"}
        </div>

        {error && <div className="login-err">{error}</div>}
        {ok    && <div className="login-ok">{ok}</div>}

        <div className="login-field">
          <label className="lbl">Email</label>
          <input className="login-input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="tu@empresa.com"/>
        </div>

        {modo !== "reset" && (
          <div className="login-field">
            <label className="lbl">Contraseña</label>
            <input className="login-input" type="password" value={pass} onChange={e=>setPass(e.target.value)}
              placeholder="••••••••"
              onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
            />
          </div>
        )}

        <button className="login-btn" onClick={handleSubmit} disabled={loading||!email||(modo!=="reset"&&!pass)}>
          {loading ? "Cargando..." : modo==="login" ? "Entrar" : modo==="registro" ? "Crear cuenta" : "Enviar link"}
        </button>

        {modo==="login" && (
          <>
            <div className="login-toggle">
              ¿No tenés cuenta? <span onClick={()=>{setModo("registro");setError("")}}>Registrarte</span>
            </div>
            <div className="login-toggle" style={{marginTop:8}}>
              <span onClick={()=>{setModo("reset");setError("")}}>Olvidé mi contraseña</span>
            </div>
          </>
        )}
        {modo !== "login" && (
          <div className="login-toggle">
            <span onClick={()=>{setModo("login");setError("")}}>← Volver al login</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EMPRESA FORM ─────────────────────────────────────────────────────────────
function EmpresaForm({ empresa, onSave, onCancel }) {
  const [f, setF] = useState(empresa || {
    nombre:"", sector:"", facturacion:"", empleados:"",
    certificaciones:"", experiencia:"", capacidades:"", historial:"",
    codigoPostal:"", latEmpresa:null, lonEmpresa:null, ciudadResuelta:"",
    capitalDisponible:"",
    distanciaCerca:"15", distanciaMedia:"25", distanciaLejos:"50",
  });
  const [geocoding, setGeocoding] = useState(false);
  const [geoError,  setGeoError]  = useState("");

  const s = (k) => (e) => setF(p => ({...p, [k]: e.target.value}));
  const valid = f.nombre && f.sector && f.facturacion;

  const handleCPChange = (e) => {
    const val = e.target.value.replace(/\D/g, "").slice(0, 5);
    setF(p => ({ ...p, codigoPostal: val, latEmpresa: null, lonEmpresa: null, ciudadResuelta: "" }));
    setGeoError("");
  };

  const handleVerificarCP = async () => {
    if (!f.codigoPostal || f.codigoPostal.length !== 5) return;
    setGeocoding(true);
    setGeoError("");
    try {
      const result = await geocodeCPMexico(f.codigoPostal);
      if (result) {
        setF(p => ({ ...p, latEmpresa: result.lat, lonEmpresa: result.lon, ciudadResuelta: result.ciudadResuelta }));
      } else {
        setGeoError("Código postal no encontrado. Verifica que sea un CP válido de México.");
      }
    } catch {
      setGeoError("Error al consultar. Verifica tu conexión e intenta de nuevo.");
    } finally {
      setGeocoding(false);
    }
  };

  return (
    <div className="page">
      <div className="pg-title">Perfil de Empresa</div>
      <div className="pg-sub">Se inyecta en cada análisis y en el score del dashboard. Guardado en tu dispositivo.</div>
      <div className="card">
        <div className="ct">🏢 Datos Básicos</div>
        <div className="fg">
          <div className="fl ff"><label className="lbl">Nombre *</label><input className="inp" value={f.nombre} onChange={s("nombre")} placeholder="Ej: TechSoluciones S.A."/></div>
          <div className="fl"><label className="lbl">Sector *</label><select className="sel" value={f.sector} onChange={s("sector")}><option value="">Seleccionar...</option>{SECTORES.map(x=><option key={x}>{x}</option>)}</select></div>
          <div className="fl"><label className="lbl">Facturación Anual *</label><select className="sel" value={f.facturacion} onChange={s("facturacion")}><option value="">Seleccionar...</option>{FACTURACION.map(x=><option key={x}>{x}</option>)}</select></div>
          <div className="fl"><label className="lbl">Empleados</label><input className="inp" value={f.empleados} onChange={s("empleados")} placeholder="Ej: 45"/></div>
          <div className="fl"><label className="lbl">Capital disponible para licitaciones (MXN)</label><input className="inp" type="number" min="0" value={f.capitalDisponible} onChange={s("capitalDisponible")} placeholder="Ej: 5000000"/></div>
        </div>
      </div>
      <div className="card">
        <div className="ct">⚙️ Capacidades</div>
        <div className="fg">
          <div className="fl ff"><label className="lbl">Certificaciones</label><textarea className="ta" value={f.certificaciones} onChange={s("certificaciones")} placeholder="ISO 9001, habilitaciones..."/></div>
          <div className="fl ff"><label className="lbl">Experiencia en Licitaciones</label><textarea className="ta" value={f.experiencia} onChange={s("experiencia")} placeholder="Ganamos 3 licitaciones de TI 2022-2024..."/></div>
          <div className="fl ff"><label className="lbl">Capacidades Técnicas</label><textarea className="ta" value={f.capacidades} onChange={s("capacidades")} placeholder="Planta propia, entrega en 48hs..."/></div>
          <div className="fl ff"><label className="lbl">Historial / Lecciones</label><textarea className="ta" value={f.historial} onChange={s("historial")} placeholder="Perdimos una vez por no tener seguro de caución..."/></div>
        </div>
      </div>
      <div className="card">
        <div className="ct">📍 Ubicación y Alcance</div>
        <div className="fg">
          <div className="fl ff">
            <label className="lbl">Código Postal de tu empresa</label>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <input
                className="inp"
                type="text"
                inputMode="numeric"
                maxLength={5}
                value={f.codigoPostal}
                onChange={handleCPChange}
                onKeyDown={e => e.key==="Enter" && handleVerificarCP()}
                placeholder="Ej: 83000"
                style={{width:110,flexShrink:0}}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleVerificarCP}
                disabled={!f.codigoPostal || f.codigoPostal.length !== 5 || geocoding}
              >
                {geocoding ? "Buscando…" : "Verificar"}
              </button>
              {f.ciudadResuelta && (
                <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--green)"}}>
                  ✓ {f.ciudadResuelta}
                  {f.latEmpresa && <span style={{color:"var(--ink3)",marginLeft:6}}>{f.latEmpresa.toFixed(4)}, {f.lonEmpresa.toFixed(4)}</span>}
                </span>
              )}
              {geoError && <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--red)"}}>{geoError}</span>}
            </div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--ink3)",marginTop:6}}>
              El CP se geocodifica con OpenStreetMap para calcular distancias exactas.
            </div>
          </div>
          <div className="fl">
            <label className="lbl">Cerca (km)</label>
            <input className="inp" type="number" min="1" max="500" value={f.distanciaCerca} onChange={s("distanciaCerca")} placeholder="15"/>
          </div>
          <div className="fl">
            <label className="lbl">Media distancia (km)</label>
            <input className="inp" type="number" min="1" max="500" value={f.distanciaMedia} onChange={s("distanciaMedia")} placeholder="25"/>
          </div>
          <div className="fl">
            <label className="lbl">Lejos (km)</label>
            <input className="inp" type="number" min="1" max="1000" value={f.distanciaLejos} onChange={s("distanciaLejos")} placeholder="50"/>
          </div>
          <div className="fl" style={{gridColumn:"1/-1"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--ink3)"}}>
              🟢 Cerca ≤ {f.distanciaCerca||15} km · 🟡 Media ≤ {f.distanciaMedia||25} km · 🔴 Lejos ≤ {f.distanciaLejos||50} km
            </div>
          </div>
        </div>
      </div>
      <div className="btn-row">
        <button className="btn btn-blue" disabled={!valid} onClick={()=>onSave(f)}>💾 Guardar Perfil</button>
        {onCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancelar</button>}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function LicitaIA() {
  const [user,            setUser]           = useState(null);
  const [authReady,       setAuthReady]      = useState(false);
  const [pendingApproval, setPendingApproval]= useState(false);
  const [view,            setView]           = useState("analizar");
  const [empresa,         setEmpresa]        = useState(null);
  const [historial,       setHistorial]      = useState([]);
  const [histDetail, setHistDetail]= useState(null);
  const [file,       setFile]      = useState(null);
  const [tipo,       setTipo]      = useState("viabilidad");
  const [step,       setStep]      = useState(1);
  const [loading,    setLoading]   = useState(false);
  const [result,     setResult]    = useState(null);
  const [warnings,   setWarnings]  = useState([]);
  const [error,      setError]     = useState(null);
  const [drag,       setDrag]      = useState(false);
  const [toast,      setToast]     = useState(null);
  const fileRef = useRef(null);

  // ── Revisar Propuesta ───────────────────────────────────────────────────────
  const [revBases,   setRevBases]   = useState(null);
  const [revProp,    setRevProp]    = useState(null);
  const [revDragB,   setRevDragB]   = useState(false);
  const [revDragP,   setRevDragP]   = useState(false);
  const [revLoading, setRevLoading] = useState(false);
  const [revResult,  setRevResult]  = useState(null);
  const [revError,   setRevError]   = useState(null);
  const revBasesRef = useRef(null);
  const revPropRef  = useRef(null);

  // ── Dashboard licitaciones ──────────────────────────────────────────────────
  const [licitaciones,  setLicitaciones]  = useState([]);
  const [licitLoading,  setLicitLoading]  = useState(false);
  const [licitError,    setLicitError]    = useState(null);
  const [licitMeta,     setLicitMeta]     = useState(null);
  const [rate,          setRate]          = useState(()=>{ try { return getRateLimit(); } catch { return { usos:0, ultima:null, resetAt:null }; } });
  const [filtroDepe,      setFiltroDepe]      = useState("");
  const [filtroFecha,     setFiltroFecha]     = useState("");
  const [filtroEstatus,   setFiltroEstatus]   = useState("");
  const [filtroDistancia, setFiltroDistancia] = useState("");
  const [filtroCapital,   setFiltroCapital]   = useState("");
  const [v2Token,       setV2Token]       = useState(()=>{ try { return localStorage.getItem("licitaia_v4_v2token")||""; } catch { return ""; } });
  const [showToken,     setShowToken]     = useState(false);

  // Verificar sesión al cargar + gate de aprobación
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const { data: aprobRow } = await supabase
          .from("aprobaciones").select("aprobado").eq("email", session.user.email).maybeSingle();
        if (aprobRow?.aprobado) {
          setUser(session.user);
        } else {
          await supabase.auth.signOut();
          setPendingApproval(true);
        }
      }
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") { setUser(null); setPendingApproval(false); }
      // SIGNED_IN y INITIAL_SESSION se manejan en getSession o en LoginScreen
    });
    return () => subscription.unsubscribe();
  }, []);

  // Cargar/limpiar datos del usuario cuando cambia la sesión
  useEffect(() => {
    if (!user) {
      setEmpresa(null); setHistorial([]); setLicitaciones([]); setLicitMeta(null);
      return;
    }
    setEmpresa(store.get(skEmpresa(user.id)));
    setHistorial(store.get(skHistorial(user.id)) || []);
    const cached = store.get(skLicitaciones(user.id));
    if (cached?.licitaciones?.length) {
      setLicitaciones(cached.licitaciones);
      setLicitMeta(cached.meta || null);
    }
  }, [user]);

  const showToast = useCallback((msg)=>{ setToast(msg); setTimeout(()=>setToast(null),3200); },[]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    showToast("Sesión cerrada");
  };

  const handleSaveEmpresa = useCallback((data)=>{
    store.set(skEmpresa(user.id), data); setEmpresa(data);
    showToast("✓ Perfil guardado"); setView("analizar");
  },[showToast, user]);

  // ── Fetch licitaciones (con rate limit) ──────────────────────────────────
  const fetchLicitaciones = useCallback(async ()=>{
    const current = getRateLimit();
    if (current.usos >= LICIT_MAX_USOS) {
      showToast("⚠ Límite de actualizaciones alcanzado. Espera 24 h.");
      return;
    }
    setLicitLoading(true);
    setLicitError(null);
    const next = consumeRateLimit(current);
    setRate(next);
    try {
      const tok = (() => { try { return localStorage.getItem("licitaia_v4_v2token")||""; } catch { return ""; } })();
      const url = tok ? `/api/licitaciones?token=${encodeURIComponent(tok)}` : "/api/licitaciones";
      const res = await fetch(url);
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error || `Error ${res.status}`); }
      const body = await res.json();
      const lics = body.licitaciones || [];
      const meta = { fuente: body.fuente, total: body.total, timestamp: body.timestamp, mensaje: body.mensaje, conToken: body.conToken };
      setLicitaciones(lics);
      setLicitMeta(meta);
      store.set(skLicitaciones(user.id), { licitaciones: lics, meta });
    } catch(e) {
      setLicitError(e.message || "Error desconocido");
    } finally {
      setLicitLoading(false);
    }
  }, [showToast, user]);

  // Cargar automáticamente al entrar al dashboard (sin consumir rate si ya hay datos)
  useEffect(()=>{
    if (view === "dashboard" && licitaciones.length === 0 && !licitLoading && !licitError) {
      fetchLicitaciones();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const acceptFile = useCallback((f)=>{
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")){ showToast("⚠ Solo PDF"); return; }
    if (f.size > 32*1024*1024){ showToast("⚠ Máximo 32 MB"); return; }
    setFile(f); setStep(2); setResult(null); setError(null); setWarnings([]);
  },[showToast]);

  const resetFlow = useCallback(()=>{
    setFile(null); setResult(null); setError(null); setWarnings([]);
    setStep(1); setLoading(false);
  },[]);

  const runAnalysis = useCallback(async ()=>{
    if (!file) return;
    setLoading(true); setError(null); setStep(3);
    try {
      const base64PDF = await readFileAsBase64(file);
      const { data, warnings: w } = await analyzeWithBackend({ base64PDF, tipo, empresa });
      setResult(data); setWarnings(w||[]);
      const entry = { id:Date.now(), fecha:new Date().toISOString(), archivo:file.name, tipo, veredicto:data.veredicto||null, score:data.score??null, nombre:data.licitacion?.nombre||file.name, organismo:data.licitacion?.organismo||"", data };
      const newH = [entry,...historial].slice(0,40);
      setHistorial(newH); store.set(skHistorial(user.id), newH);
    } catch(e) {
      setError(e.message||"Error desconocido"); setStep(2);
    } finally { setLoading(false); }
  },[file,tipo,empresa,historial,user]);

  const acceptRevFile = useCallback((f, slot) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) { showToast("⚠ Solo archivos PDF"); return; }
    if (f.size > 32*1024*1024) { showToast("⚠ Máximo 32 MB por archivo"); return; }
    if (slot === "bases") { setRevBases(f); setRevResult(null); setRevError(null); }
    else                  { setRevProp(f);  setRevResult(null); setRevError(null); }
  }, [showToast]);

  const runRevision = useCallback(async () => {
    if (!revBases || !revProp) return;
    setRevLoading(true); setRevError(null); setRevResult(null);
    try {
      const [bases64, propuesta64] = await Promise.all([
        readFileAsBase64(revBases),
        readFileAsBase64(revProp),
      ]);
      const res = await fetch("/api/revisar-propuesta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bases64, propuesta64, empresa: empresa || null }),
      });
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error || `Error ${res.status}`); }
      const body = await res.json();
      if (!body.data) throw new Error("El servidor no devolvió datos");
      setRevResult(body.data);
    } catch (e) {
      setRevError(e.message || "Error desconocido");
    } finally {
      setRevLoading(false);
    }
  }, [revBases, revProp, empresa]);

  // Pantalla de carga inicial
  if (!authReady) {
    return (
      <>
        <style>{CSS}</style>
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)"}}>
          <div className="loading"><div className="spinner"/><div className="ld-msg">Cargando...</div></div>
        </div>
      </>
    );
  }

  // Cuenta pendiente de aprobación
  if (pendingApproval) {
    return (
      <>
        <style>{CSS}</style>
        <div className="login-wrap">
          <div className="login-card">
            <div className="login-logo">Licita<em>IA</em></div>
            <div className="login-sub">Motor de Licitaciones</div>
            <div style={{textAlign:"center",padding:"28px 0 20px"}}>
              <div style={{fontSize:44,marginBottom:14}}>⏳</div>
              <div style={{fontFamily:"var(--display)",fontSize:18,fontWeight:700,marginBottom:10}}>Cuenta en revisión</div>
              <div style={{fontSize:13.5,color:"var(--ink3)",lineHeight:1.65}}>
                Tu cuenta está siendo revisada por el administrador.<br/>
                Te avisaremos cuando tengas acceso.
              </div>
            </div>
            <button className="login-btn" onClick={()=>setPendingApproval(false)}>← Volver al login</button>
          </div>
        </div>
      </>
    );
  }

  // Si no hay sesión, mostrar login
  if (!user) {
    return (
      <>
        <style>{CSS}</style>
        <LoginScreen onLogin={setUser}/>
      </>
    );
  }

  // App principal
  const steps = [["1","Subir PDF"],["2","Configurar"],["3","Resultado"]];

  return (
    <>
      <style>{CSS}</style>
      <div className="shell">
        <aside className="sidebar">
          <div className="logo-wrap">
            <div className="logo">Licita<em>IA</em></div>
            <div className="logo-sub">Motor de Licitaciones</div>
          </div>
          <nav>
            {[
              {id:"analizar",  icon:"⚡", label:"Nuevo Análisis"},
              {id:"dashboard", icon:"📋", label:"Licitaciones Sonora", badge:licitaciones.length||null},
              {id:"revisar",   icon:"🔍", label:"Revisar Propuesta"},
              {id:"historial", icon:"📂", label:"Historial", badge:historial.length||null},
              {id:"empresa",   icon:"🏢", label:empresa?"Perfil Empresa":"⚠ Configurar Empresa"},
            ].map(n=>(
              <button key={n.id} className={`nb ${view===n.id?"on":""}`} onClick={()=>setView(n.id)}>
                <span>{n.icon}</span>{n.label}
                {n.badge?<span className="nb-badge">{n.badge}</span>:null}
              </button>
            ))}
          </nav>
          {empresa ? (
            <div className="emp-mini">
              <div className="emp-name">🏢 {empresa.nombre}</div>
              <div className="emp-meta">{empresa.sector}<br/>{empresa.facturacion}{empresa.empleados&&<><br/>{empresa.empleados} emp.</>}</div>
            </div>
          ) : (
            <div className="no-emp">Sin perfil.<br/><span onClick={()=>setView("empresa")}>Configurar →</span></div>
          )}
          <div className="user-info">
            <span className="user-email">{user.email}</span>
            <button className="btn-signout" onClick={handleSignOut}>Salir</button>
          </div>
        </aside>

        <main className="main">
          {view==="analizar" && (
            <div className="page">
              <div className="pg-title">Nuevo Análisis</div>
              <div className="pg-sub">Subí un pliego y obtené análisis estructurado con trazabilidad.</div>
              {!empresa && (
                <div className="warn-banner">
                  ⚠️ Sin perfil de empresa — el análisis será genérico.{" "}
                  <span style={{color:"var(--blue)",cursor:"pointer",fontWeight:600,marginLeft:4}} onClick={()=>setView("empresa")}>Configurar →</span>
                </div>
              )}
              {empresa && <div className="ctx-pill">🏢 <strong>{empresa.nombre}</strong></div>}

              <div className="stepper">
                {steps.map(([n,label],idx)=>{
                  const s=step>idx+1?"done":step===idx+1?"active":"pending";
                  return (
                    <div key={n} style={{display:"flex",alignItems:"center",flex:idx<2?1:0}}>
                      <div className={`step ${s}`}>
                        <div className="sn">{s==="done"?"✓":n}</div>
                        <div className="sl">{label}</div>
                      </div>
                      {idx<2&&<div className={`sline ${step>idx+1?"done":""}`}/>}
                    </div>
                  );
                })}
              </div>

              {step===1 && (
                <div className="card">
                  <div className={`upload-zone ${drag?"drag":""}`}
                    onDragOver={e=>{e.preventDefault();setDrag(true)}}
                    onDragLeave={()=>setDrag(false)}
                    onDrop={e=>{e.preventDefault();setDrag(false);acceptFile(e.dataTransfer.files[0])}}
                    onClick={()=>fileRef.current?.click()}>
                    <div className="uz-icon">📄</div>
                    <div className="uz-title">Arrastrá el pliego aquí</div>
                    <div className="uz-sub">o hacé clic para seleccionar</div>
                    <div className="uz-fmt">PDF · Máx. 32 MB</div>
                  </div>
                  <input ref={fileRef} type="file" accept=".pdf,application/pdf" style={{display:"none"}} onChange={e=>acceptFile(e.target.files[0])}/>
                </div>
              )}

              {step===2 && file && (
                <div className="card">
                  <div className="file-row">
                    <div style={{fontSize:28}}>📄</div>
                    <div style={{flex:1}}>
                      <div className="fi-name">{file.name}</div>
                      <div className="fi-meta">{fmtSize(file.size)} · PDF</div>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={resetFlow}>Cambiar</button>
                  </div>
                  <div className="ct" style={{fontSize:15,marginBottom:14}}>Tipo de análisis</div>
                  <div className="tipo-grid">
                    {TIPOS.map(t=>(
                      <button key={t.id} className={`tipo-opt ${tipo===t.id?"sel":""}`} onClick={()=>setTipo(t.id)}>
                        <div className="to-icon">{t.icon}</div>
                        <div className="to-title">{t.label}</div>
                        <div className="to-desc">{t.desc}</div>
                      </button>
                    ))}
                  </div>
                  {error && <div className="err-box">✗ {error}</div>}
                  <div className="btn-row">
                    <button className="btn btn-blue" onClick={runAnalysis} disabled={loading}>⚡ Analizar Documento</button>
                    <button className="btn btn-ghost" onClick={resetFlow}>Cancelar</button>
                  </div>
                </div>
              )}

              {step===3 && (
                <div className="card">
                  {loading ? (
                    <div className="loading">
                      <div className="spinner"/>
                      <div className="ld-msg">Analizando el pliego...</div>
                      <div className="ld-sub">Leyendo PDF · extrayendo datos · validando</div>
                    </div>
                  ) : result ? (
                    <>
                      <ResultRenderer data={result} warnings={warnings}/>
                      <div className="btn-row" style={{marginTop:22,paddingTop:18,borderTop:"1px solid var(--border)"}}>
                        <button className="btn btn-blue" onClick={resetFlow}>⚡ Nuevo Análisis</button>
                        <button className="btn btn-ghost" onClick={()=>{setResult(null);setStep(2)}}>Cambiar tipo</button>
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {view==="historial" && (
            <div className="page">
              <div className="pg-title">Historial</div>
              <div className="pg-sub">{historial.length} análisis guardados.</div>
              {histDetail ? (
                <div className="card">
                  <div className="btn-row" style={{marginBottom:20}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setHistDetail(null)}>← Volver</button>
                    <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--ink3)"}}>{histDetail.archivo} · {fmtDate(histDetail.fecha)}</span>
                  </div>
                  <ResultRenderer data={histDetail.data} warnings={[]}/>
                </div>
              ) : historial.length===0 ? (
                <div className="empty-state"><div className="ei">📂</div><div className="et">Sin análisis realizados</div></div>
              ) : (
                <>
                  {historial.map(h=>(
                    <div key={h.id} className="hi" onClick={()=>setHistDetail(h)}>
                      <div>
                        {h.veredicto
                          ? <div className={`hb ${h.veredicto}`}>{h.veredicto==="GO"?"✓ PRESENTARSE":h.veredicto==="NOGO"?"✗ NO PRESENTARSE":"⚠ REVISAR"}</div>
                          : <div className="hb generic">{TIPOS.find(t=>t.id===h.tipo)?.icon} {TIPOS.find(t=>t.id===h.tipo)?.label}</div>}
                      </div>
                      <div style={{flex:1}}>
                        <div className="hi-name">{h.nombre}</div>
                        <div className="hi-meta">{h.organismo&&`${h.organismo} · `}{fmtDate(h.fecha)} · {h.archivo}</div>
                      </div>
                      {h.score!=null&&<div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:scoreCol(h.score)}}>{h.score}</div>}
                    </div>
                  ))}
                  <button className="btn-danger" onClick={()=>{setHistorial([]);store.del(skHistorial(user.id));showToast("Historial eliminado")}}>🗑 Limpiar historial</button>
                </>
              )}
            </div>
          )}

          {view==="empresa" && (
            <EmpresaForm empresa={empresa} onSave={handleSaveEmpresa} onCancel={empresa?()=>setView("analizar"):null}/>
          )}

          {view==="dashboard" && (() => {
            const usosDisp = Math.max(0, LICIT_MAX_USOS - rate.usos);
            const limitado = usosDisp === 0;
            const fmtTs = (ts) => ts ? new Date(ts).toLocaleString("es-MX",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";

            // Dependencias y estatuses únicos para los filtros
            const dependencias = [...new Set(licitaciones.map(l=>l.dependencia).filter(Boolean))].sort();
            const estatuses    = [...new Set(licitaciones.map(l=>l.estatus).filter(s=>s&&s!=="—"))].sort();

            // Enriquecer cada licitación con score y distancia
            const enriquecidas = licitaciones.map(l => {
              const score = scoreEmpresa(l, empresa);
              const ciudadDep = extractCiudad(l.dependencia);
              const km = empresa?.latEmpresa ? calcDistanciaKm(empresa, ciudadDep) : null;
              const distCat = distanciaCategoria(km, empresa);
              return { ...l, score, km, distCat };
            });

            // Aplicar filtros
            const visibles = enriquecidas
              .filter(l => !filtroDepe    || l.dependencia === filtroDepe)
              .filter(l => !filtroFecha   || (l.fechaPublicacion && l.fechaPublicacion >= filtroFecha))
              .filter(l => !filtroEstatus || (l.estatus && l.estatus.toUpperCase().includes(filtroEstatus.toUpperCase())))
              .filter(l => {
                if (!filtroDistancia || !empresa?.latEmpresa) return true;
                return l.distCat === filtroDistancia;
              })
              .filter(l => {
                if (!filtroCapital || !empresa?.capitalDisponible) return true;
                const cap = Number(empresa.capitalDisponible);
                if (!cap || isNaN(cap)) return true;
                if (l.monto === null || l.monto === undefined || isNaN(Number(l.monto))) return true;
                return Number(l.monto) <= cap;
              })
              .sort((a,b) => {
                // Si hay empresa: ordenar por score desc, luego fecha desc
                // Sin empresa: ordenar por fecha desc
                if (empresa) {
                  const ds = (b.score ?? -1) - (a.score ?? -1);
                  if (ds !== 0) return ds;
                }
                return (b.fechaPublicacion || "").localeCompare(a.fechaPublicacion || "");
              });

            return (
              <div className="page">
                <div className="pg-title">Licitaciones Sonora</div>
                <div className="pg-sub">
                  Licitaciones VIGENTES de CompraNet Sonora v2 · Score de relevancia según tu perfil de empresa.
                </div>

                {!empresa && (
                  <div className="dash-score-hint">
                    ⭐ Configura tu perfil para ver scores personalizados y el filtro de distancia.{" "}
                    <span style={{color:"var(--blue)",cursor:"pointer",fontWeight:600}} onClick={()=>setView("empresa")}>Configurar perfil →</span>
                  </div>
                )}

                {/* ── Toolbar ── */}
                <div className="dash-toolbar">
                  <div className="dash-filters">
                    <select className="dash-sel" value={filtroDepe} onChange={e=>setFiltroDepe(e.target.value)}>
                      <option value="">Todas las dependencias</option>
                      {dependencias.map(d=><option key={d} value={d}>{d}</option>)}
                    </select>
                    <select className="dash-sel" value={filtroEstatus} onChange={e=>setFiltroEstatus(e.target.value)}>
                      <option value="">Todos los estatus</option>
                      {estatuses.map(s=><option key={s} value={s}>{s}</option>)}
                    </select>
                    {empresa?.latEmpresa && (
                      <select className="dash-sel" value={filtroDistancia} onChange={e=>setFiltroDistancia(e.target.value)}>
                        <option value="">📍 Todas las distancias</option>
                        <option value="cerca">🟢 Cerca (≤{empresa.distanciaCerca||15} km)</option>
                        <option value="media">🟡 Media (≤{empresa.distanciaMedia||25} km)</option>
                        <option value="lejos">🔴 Lejos (≤{empresa.distanciaLejos||50} km)</option>
                      </select>
                    )}
                    {empresa?.capitalDisponible && (
                      <select className="dash-sel" value={filtroCapital} onChange={e=>setFiltroCapital(e.target.value)}>
                        <option value="">💰 Todo monto</option>
                        <option value="apto">💰 Dentro de mi capital</option>
                      </select>
                    )}
                    <input type="date" className="dash-inp" value={filtroFecha} onChange={e=>setFiltroFecha(e.target.value)} title="Publicadas desde"/>
                    {(filtroDepe||filtroFecha||filtroEstatus||filtroDistancia||filtroCapital) && (
                      <button className="btn btn-ghost btn-sm" onClick={()=>{setFiltroDepe("");setFiltroFecha("");setFiltroEstatus("");setFiltroDistancia("");setFiltroCapital("");}}>✕ Limpiar</button>
                    )}
                  </div>

                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
                    <button
                      className="btn btn-blue btn-sm"
                      disabled={licitLoading || limitado}
                      onClick={fetchLicitaciones}
                      style={{gap:6}}
                    >
                      {licitLoading ? "Cargando…" : limitado ? `⏳ Reinicio: ${fmtTs(rate.resetAt)}` : "↺ Actualizar"}
                    </button>
                    <span className="dash-rate">
                      {limitado ? "Límite diario alcanzado" : `Usos disponibles: ${usosDisp} de ${LICIT_MAX_USOS}`}
                    </span>
                    {rate.ultima && <span className="dash-last">Últ. actualización: {fmtTs(rate.ultima)}</span>}
                  </div>
                </div>

                {/* ── Estado: cargando ── */}
                {licitLoading && (
                  <div className="loading" style={{padding:"48px 0"}}>
                    <div className="spinner"/>
                    <div className="ld-msg">Consultando CompraNet Sonora…</div>
                    <div className="ld-sub">Descargando datos del portal · puede tardar ~10 s</div>
                  </div>
                )}

                {/* ── Estado: error ── */}
                {!licitLoading && licitError && (
                  <div className="err-box" style={{marginBottom:18}}>✗ {licitError}</div>
                )}

                {/* ── Panel de token v2 (colapsable) ── */}
                <div style={{marginBottom:16}}>
                  <button className="btn btn-ghost btn-sm" style={{fontSize:11,gap:5}} onClick={()=>setShowToken(t=>!t)}>
                    🔑 {showToken ? "Ocultar" : "Desbloquear datos v2"} {v2Token?"✓":""}
                  </button>
                  {showToken && (
                    <div className="card" style={{marginTop:10,padding:14}}>
                      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--ink3)",marginBottom:8}}>
                        Para ver licitaciones VIGENTES del sistema v2: abrí DevTools en compranetv2.sonora.gob.mx
                        → Application → LocalStorage → buscar <strong>tk_str</strong> → copiá el valor.
                      </div>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input
                          className="inp"
                          style={{flex:1,fontSize:12,fontFamily:"var(--mono)"}}
                          type="password"
                          placeholder="Pegar token JWT de CompraNet v2..."
                          value={v2Token}
                          onChange={e=>{
                            setV2Token(e.target.value);
                            try { localStorage.setItem("licitaia_v4_v2token", e.target.value); } catch {}
                          }}
                        />
                        {v2Token && (
                          <button className="btn-danger" style={{fontSize:11,padding:"5px 10px"}} onClick={()=>{
                            setV2Token("");
                            try { localStorage.removeItem("licitaia_v4_v2token"); } catch {}
                          }}>✕</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Fuente + conteo ── */}
                {!licitLoading && licitaciones.length > 0 && (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16,flexWrap:"wrap"}}>
                    <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--ink3)"}}>
                      {visibles.length} de {licitaciones.length} licitaciones
                      {filtroDepe || filtroFecha ? " (filtradas)" : ""}
                    </span>
                    {licitMeta?.fuente && (
                      <span className="dash-fuente">
                        {licitMeta.fuente === "api-v2-portal" ? "🟢 CompraNet v2 — VIGENTES (portal público)" :
                         licitMeta.fuente === "api-v2-jwt"    ? "🟢 CompraNet v2 — vigentes (con token)" :
                         licitMeta.fuente.includes("csv")     ? `🟡 Portal v1 — histórico (${licitMeta.total} registros)` :
                         licitMeta.fuente.includes("dt")      ? "🟡 Portal v1 — JSON" : licitMeta.fuente}
                      </span>
                    )}
                  </div>
                )}

                {/* ── Grid de tarjetas ── */}
                {!licitLoading && visibles.length > 0 && (
                  <div className="lic-grid">
                    {visibles.map(l => {
                      const sc = l.score;
                      const estatusUp = (l.estatus || "").toUpperCase();
                      const esVigente    = !l.estatus || estatusUp.includes("VIGENTE") || l.estatus === "—";
                      const esSeguimiento = estatusUp.includes("SEGUIMIENTO");
                      const esAdjudicada  = estatusUp.includes("ADJUDICADA");
                      return (
                        <div key={l.id} className="lic-card">
                          <div className="lic-head">
                            <div style={{flex:1}}>
                              <div className="lic-titulo">{l.titulo}</div>
                              <div className="lic-dep">{l.dependencia}</div>
                            </div>
                            <div className="lic-num-wrap">
                              <div className="lic-num">{l.numero !== "—" ? `#${l.numero}` : ""}</div>
                              {l.numero && l.numero !== "—" && (
                                <button
                                  className="lic-copy"
                                  title="Copiar número de procedimiento"
                                  onClick={() => {
                                    navigator.clipboard?.writeText(l.numero)
                                      .then(() => showToast("✓ Número copiado"))
                                      .catch(() => showToast("No se pudo copiar"));
                                  }}
                                >📋</button>
                              )}
                            </div>
                          </div>

                          <div className="lic-meta">
                            <span className={`lic-badge ${esVigente?"vigente":esSeguimiento?"seguimiento":esAdjudicada?"adjudicada":"otro"}`}>{l.estatus}</span>
                            {l.modalidad && l.modalidad !== "—" && <span className="lic-badge otro">{l.modalidad}</span>}
                            {l.tipo && l.tipo !== "—" && <span className="lic-badge otro">{l.tipo}</span>}
                            {l.distCat && l.distCat !== "muyLejos" && (
                              <span className={`lic-dist ${l.distCat}`} title={`${Math.round(l.km)} km`}>
                                {l.distCat==="cerca"?"🟢 Cerca":l.distCat==="media"?"🟡 Media":"🔴 Lejos"}
                                {" "}{Math.round(l.km)} km
                              </span>
                            )}
                            {l.distCat === "muyLejos" && (
                              <span className="lic-dist lejos" title={`${Math.round(l.km)} km — fuera de tu rango`}>
                                🔴 {Math.round(l.km)} km
                              </span>
                            )}
                          </div>

                          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                            {l.fechaPublicacion && (
                              <div className="lic-date">📅 Pub: {l.fechaPublicacion}</div>
                            )}
                            {l.fechaLimite && (
                              <div className="lic-date">⏰ Límite: {l.fechaLimite}</div>
                            )}
                            {l.monto && (
                              <div className="lic-date">💰 {Number(l.monto).toLocaleString("es-MX",{style:"currency",currency:"MXN",maximumFractionDigits:0})}</div>
                            )}
                          </div>

                          <div className="lic-anticipo">
                            {l.anticipo !== null && l.anticipo !== undefined
                              ? <span style={{color:"var(--green)"}}>💵 Anticipo: {l.anticipo}%</span>
                              : <span className="lic-anticipo-nd">Sin datos de anticipo</span>
                            }
                          </div>

                          {/* Score de relevancia */}
                          {sc !== null && (
                            <div className="lic-score-row">
                              <div className="lic-score-num" style={{color:scoreColor(sc)}}>{sc}</div>
                              <div style={{flex:1}}>
                                <div className="lic-score-bar-wrap">
                                  <div className="lic-score-bar" style={{width:`${sc}%`,background:scoreColor(sc)}}/>
                                </div>
                                <div className="lic-score-lbl" style={{marginTop:3}}>
                                  {sc>=70?"Alta relevancia":sc>=45?"Relevancia media":"Baja relevancia"}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Enlace al portal */}
                          <div className="lic-actions">
                            <a
                              className="lic-portal-link"
                              href="https://compranetv2.sonora.gob.mx/inicio/portal-licitaciones"
                              target="_blank"
                              rel="noopener noreferrer"
                              title={l.numero !== "—" ? `Buscar "${l.numero}" en CompraNet Sonora` : "Ver portal CompraNet Sonora"}
                            >
                              Ver en CompraNet →
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ── Sin resultados ── */}
                {!licitLoading && !licitError && licitaciones.length > 0 && visibles.length === 0 && (
                  <div className="dash-empty">
                    <div className="de-icon">🔍</div>
                    <div className="de-title">Sin resultados con estos filtros</div>
                    <div className="de-sub">
                      <button className="btn btn-ghost btn-sm" onClick={()=>{setFiltroDepe("");setFiltroFecha("");setFiltroEstatus("");setFiltroDistancia("");setFiltroCapital("");}}>Limpiar filtros</button>
                    </div>
                  </div>
                )}

                {!licitLoading && !licitError && licitaciones.length === 0 && (
                  <div className="dash-empty">
                    <div className="de-icon">📋</div>
                    <div className="de-title">Sin licitaciones cargadas</div>
                    <div className="de-sub">
                      {licitMeta?.mensaje || "Presioná Actualizar para extraer las licitaciones vigentes del portal CompraNet Sonora."}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {view==="revisar" && (
            <div className="page">
              <div className="pg-title">Revisar Propuesta</div>
              <div className="pg-sub">Sube las bases de la licitación y tu propuesta — la IA verifica cada requisito y te da un dictamen.</div>

              {!revResult && (
                <>
                  {/* Upload zones */}
                  <div className="rev-upload-grid">
                    {/* Bases */}
                    <div>
                      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--ink3)",marginBottom:6}}>DOCUMENTO 1 — Bases de la licitación</div>
                      <div
                        className={`rev-zone ${revDragB?"drag":""} ${revBases?"loaded":""}`}
                        onDragOver={e=>{e.preventDefault();setRevDragB(true)}}
                        onDragLeave={()=>setRevDragB(false)}
                        onDrop={e=>{e.preventDefault();setRevDragB(false);acceptRevFile(e.dataTransfer.files[0],"bases")}}
                        onClick={()=>!revBases&&revBasesRef.current?.click()}
                      >
                        <div className="rev-zone-icon">{revBases?"📄":"📋"}</div>
                        {revBases ? (
                          <>
                            <div className="rev-zone-file">{revBases.name}</div>
                            <div className="rev-zone-sub">{(revBases.size/1024).toFixed(0)} KB · PDF</div>
                            <button className="rev-zone-clear" onClick={e=>{e.stopPropagation();setRevBases(null);setRevResult(null);setRevError(null)}}>Cambiar</button>
                          </>
                        ) : (
                          <>
                            <div className="rev-zone-label">Bases de licitación</div>
                            <div className="rev-zone-sub">Arrastrá o hacé clic · PDF · Máx. 32 MB</div>
                          </>
                        )}
                      </div>
                      <input ref={revBasesRef} type="file" accept=".pdf,application/pdf" style={{display:"none"}} onChange={e=>acceptRevFile(e.target.files[0],"bases")}/>
                    </div>

                    {/* Propuesta */}
                    <div>
                      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--ink3)",marginBottom:6}}>DOCUMENTO 2 — Mi propuesta</div>
                      <div
                        className={`rev-zone ${revDragP?"drag":""} ${revProp?"loaded":""}`}
                        onDragOver={e=>{e.preventDefault();setRevDragP(true)}}
                        onDragLeave={()=>setRevDragP(false)}
                        onDrop={e=>{e.preventDefault();setRevDragP(false);acceptRevFile(e.dataTransfer.files[0],"propuesta")}}
                        onClick={()=>!revProp&&revPropRef.current?.click()}
                      >
                        <div className="rev-zone-icon">{revProp?"📄":"📝"}</div>
                        {revProp ? (
                          <>
                            <div className="rev-zone-file">{revProp.name}</div>
                            <div className="rev-zone-sub">{(revProp.size/1024).toFixed(0)} KB · PDF</div>
                            <button className="rev-zone-clear" onClick={e=>{e.stopPropagation();setRevProp(null);setRevResult(null);setRevError(null)}}>Cambiar</button>
                          </>
                        ) : (
                          <>
                            <div className="rev-zone-label">Mi propuesta</div>
                            <div className="rev-zone-sub">Arrastrá o hacé clic · PDF · Máx. 32 MB</div>
                          </>
                        )}
                      </div>
                      <input ref={revPropRef} type="file" accept=".pdf,application/pdf" style={{display:"none"}} onChange={e=>acceptRevFile(e.target.files[0],"propuesta")}/>
                    </div>
                  </div>

                  {empresa && <div className="ctx-pill">🏢 <strong>{empresa.nombre}</strong> · análisis personalizado</div>}
                  {!empresa && (
                    <div className="dash-score-hint" style={{marginBottom:16}}>
                      ⭐ Sin perfil de empresa — el análisis será genérico.{" "}
                      <span style={{color:"var(--blue)",cursor:"pointer",fontWeight:600}} onClick={()=>setView("empresa")}>Configurar →</span>
                    </div>
                  )}

                  {revError && <div className="err-box">✗ {revError}</div>}

                  <div className="btn-row">
                    <button
                      className="btn btn-blue"
                      disabled={!revBases || !revProp || revLoading}
                      onClick={runRevision}
                    >
                      {revLoading ? "Analizando..." : "🔍 Revisar Propuesta"}
                    </button>
                    {(revBases || revProp) && (
                      <button className="btn btn-ghost" onClick={()=>{setRevBases(null);setRevProp(null);setRevResult(null);setRevError(null);}}>
                        Limpiar
                      </button>
                    )}
                  </div>

                  {revLoading && (
                    <div className="card" style={{marginTop:20}}>
                      <div className="loading">
                        <div className="spinner"/>
                        <div className="ld-msg">Leyendo las bases y la propuesta...</div>
                        <div className="ld-sub">Extrayendo requisitos · Comparando · Generando dictamen</div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {revResult && (
                <div className="card">
                  <RevisionResult data={revResult}/>
                  <div className="btn-row" style={{marginTop:22,paddingTop:18,borderTop:"1px solid var(--border)"}}>
                    <button className="btn btn-blue" onClick={()=>{setRevResult(null);setRevError(null);}}>🔍 Nueva revisión</button>
                    <button className="btn btn-ghost" onClick={()=>{setRevBases(null);setRevProp(null);setRevResult(null);setRevError(null);}}>Empezar de cero</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
