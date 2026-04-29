// pages/api/revisar-propuesta.js
// Recibe dos PDFs en base64 (bases + propuesta) y devuelve análisis de cumplimiento

export const config = { api: { bodyParser: { sizeLimit: "80mb" } } };

import { setCORS, isPDFBase64 } from "../../lib/security";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL      = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

function safeParse(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateStructure(d) {
  if (!d || typeof d !== "object") return false;
  if (!["APROBADO","EN_RIESGO","INCOMPLETO"].includes(d.estado)) return false;
  if (!Array.isArray(d.checklist)) return false;
  if (!Array.isArray(d.errores)) return false;
  if (!Array.isArray(d.recomendaciones)) return false;
  return true;
}

function normalize(d) {
  d.checklist = (d.checklist || []).map(r => ({
    requisito:          String(r.requisito || "—"),
    estado:             ["CUMPLIDO","PARCIAL","FALTANTE"].includes(r.estado) ? r.estado : "PARCIAL",
    descripcion:        String(r.descripcion || ""),
    fuente_base:        String(r.fuente_base || ""),
    evidencia_propuesta:String(r.evidencia_propuesta || ""),
  }));
  d.errores = (d.errores || []).map(e => (typeof e === "string" ? e : String(e)));
  d.recomendaciones = (d.recomendaciones || []).map(r => (typeof r === "string" ? r : String(r)));
  if (typeof d.score !== "number") d.score = null;
  if (d.score !== null) d.score = Math.min(100, Math.max(0, Math.round(d.score)));
  return d;
}

function buildFallback() {
  return {
    estado: "INCOMPLETO",
    resumen: "No se pudo analizar los documentos. Intenta nuevamente.",
    score: null,
    licitacion: { nombre: "—", numero: "—", organismo: "—" },
    checklist: [],
    errores: ["El análisis automático no pudo completarse."],
    recomendaciones: ["Revisa que los PDFs sean legibles e inténtalo de nuevo."],
  };
}

function buildPrompt(empresa) {
  const ctx = empresa
    ? `PERFIL DE EMPRESA: ${empresa.nombre} · Sector: ${empresa.sector} · Facturación: ${empresa.facturacion}
Certificaciones: ${empresa.certificaciones || "ninguna"} · Capacidades: ${empresa.capacidades || "no especificadas"}`
    : "Sin perfil de empresa. Análisis general.";

  return `Tienes DOS documentos:
- DOCUMENTO 1: Bases de la licitación (pliego oficial con todos los requisitos)
- DOCUMENTO 2: Propuesta de la empresa (documento que presentará la empresa)

${ctx}

Tu tarea es COMPARAR la propuesta contra cada requisito de las bases y generar un informe de cumplimiento.

Responde ÚNICAMENTE con este JSON exacto. Sin texto antes, sin texto después, sin backticks.

{
  "estado": "APROBADO|EN_RIESGO|INCOMPLETO",
  "resumen": "string — 2-3 oraciones describiendo el estado general de la propuesta",
  "score": number,
  "licitacion": {
    "nombre": "string",
    "numero": "string",
    "organismo": "string"
  },
  "checklist": [
    {
      "requisito": "string — nombre del requisito extraído de las bases",
      "estado": "CUMPLIDO|PARCIAL|FALTANTE",
      "descripcion": "string — explicación breve de por qué está cumplido, parcial o faltante",
      "fuente_base": "string — sección o artículo de las bases donde aparece el requisito",
      "evidencia_propuesta": "string — qué presenta o qué falta en la propuesta"
    }
  ],
  "errores": ["string — descripción clara de cada error o requisito faltante crítico"],
  "recomendaciones": ["string — acción concreta para mejorar o corregir la propuesta"]
}

Reglas:
- APROBADO: todos los requisitos críticos cumplidos, score >= 80
- EN_RIESGO: hay requisitos parciales o faltantes no críticos, score 50-79
- INCOMPLETO: hay requisitos críticos faltantes, score < 50
- score refleja la probabilidad de éxito de 0 a 100
- Extrae TODOS los requisitos obligatorios de las bases
- "errores" contiene solo los problemas críticos que podrían descalificar la propuesta
- "recomendaciones" son acciones específicas y accionables
- Nunca inventes información que no esté en los documentos`;
}

export default async function handler(req, res) {
  const corsOk = setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!corsOk)                  return res.status(403).json({ error: "Origen no permitido" });
  if (req.method !== "POST")    return res.status(405).json({ error: "Método no permitido" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Configuración del servidor incompleta" });

  const { bases64, propuesta64, empresa } = req.body || {};

  if (!bases64 || typeof bases64 !== "string")
    return res.status(400).json({ error: "Campo 'bases64' requerido (PDF en base64)" });
  if (!propuesta64 || typeof propuesta64 !== "string")
    return res.status(400).json({ error: "Campo 'propuesta64' requerido (PDF en base64)" });
  if (bases64.length > 43_000_000 || propuesta64.length > 43_000_000)
    return res.status(413).json({ error: "Uno de los PDFs supera el límite de 32 MB" });
  if (!isPDFBase64(bases64))
    return res.status(400).json({ error: "El archivo de bases no es un PDF válido" });
  if (!isPDFBase64(propuesta64))
    return res.status(400).json({ error: "El archivo de propuesta no es un PDF válido" });

  const prompt = buildPrompt(empresa || null);

  let claudeRes;
  try {
    claudeRes = await fetch(CLAUDE_API, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system: `Eres LicitaIA, especialista en revisión de propuestas para licitaciones públicas.
REGLAS ABSOLUTAS:
1. Responde SOLO con JSON válido. Cero texto fuera del JSON. Cero backticks.
2. "estado" solo puede ser: APROBADO, EN_RIESGO o INCOMPLETO.
3. Cada ítem de "checklist.estado" solo puede ser: CUMPLIDO, PARCIAL o FALTANTE.
4. "errores" y "recomendaciones" son arrays de strings simples.
5. "score" es un número entre 0 y 100.
6. Nunca inventes datos que no estén en los documentos.`,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: "DOCUMENTO 1 — Bases de la licitación (pliego oficial):",
            },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: bases64 },
            },
            {
              type: "text",
              text: "DOCUMENTO 2 — Propuesta de la empresa:",
            },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: propuesta64 },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch (networkErr) {
    console.error("[LicitaIA] revisar-propuesta red:", networkErr.message);
    return res.status(502).json({ error: "Error de conexión con el motor de IA." });
  }

  if (!claudeRes.ok) {
    const errBody = await claudeRes.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Error ${claudeRes.status}`;
    console.error("[LicitaIA] Claude API:", msg);
    return res.status(502).json({ error: `Motor de IA: ${msg}` });
  }

  const claudeData = await claudeRes.json();
  const rawText    = claudeData?.content?.[0]?.text || "";

  if (!rawText) return res.status(502).json({ error: "El motor de IA devolvió respuesta vacía" });

  const parsed = safeParse(rawText);

  if (!validateStructure(parsed)) {
    console.warn("[LicitaIA] revisar-propuesta schema inválido:", rawText.slice(0, 200));
    return res.status(200).json({ data: buildFallback(), valid: false });
  }

  return res.status(200).json({ data: normalize(parsed), valid: true });
}
