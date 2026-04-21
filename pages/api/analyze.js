// pages/api/analyze.js
// Deploy: Next.js (Vercel) o cualquier Node 18+
// Requiere: ANTHROPIC_API_KEY en variables de entorno
// No se necesitan dependencias adicionales

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL      = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

// ─── SAFE PARSE ───────────────────────────────────────────────────────────────
function safeParse(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    // Extraer primer objeto JSON válido
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ─── VALIDATE STRUCTURE ───────────────────────────────────────────────────────
function validateStructure(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.resumen !== "string" || !data.resumen) return false;
  if (!Array.isArray(data.requisitos)) return false;
  if (typeof data.conclusion !== "string" || !data.conclusion) return false;
  return true;
}

// ─── NORMALIZE OUTPUT ─────────────────────────────────────────────────────────
function normalize(data, tipo) {
  // Garantizar trazabilidad en cada requisito
  data.requisitos = (data.requisitos || []).map(r => ({
    requisito:      String(r.requisito || "Requisito sin descripción"),
    estado:         ["OK","WARN","NOGO"].includes(r.estado) ? r.estado : "WARN",
    nota:           String(r.nota || ""),
    fuente:         String(r.fuente || "Fuente no identificada claramente"),
    texto_original: String(r.texto_original || "Fuente no identificada claramente"),
  }));

  // Garantizar riesgos como array de strings
  data.riesgos = (data.riesgos || []).map(r =>
    typeof r === "string" ? r : String(r.requisito || r.descripcion || JSON.stringify(r))
  );

  // Agregar riesgo automático si hay WARN/NOGO sin riesgos
  const incompletos = data.requisitos.filter(r => r.estado !== "OK");
  if (incompletos.length > 0 && data.riesgos.length === 0) {
    data.riesgos.push(`${incompletos.length} requisito(s) requieren revisión antes de presentar oferta.`);
  }

  // Garantizar veredicto válido
  if (!["GO","NOGO","REVISAR"].includes(data.veredicto)) {
    data.veredicto = "REVISAR";
  }

  // Garantizar conclusión con recomendación explícita
  if (data.conclusion && !data.conclusion.includes("Recomendación:")) {
    const suffix = data.veredicto === "GO"
      ? "Participar"
      : data.veredicto === "NOGO"
        ? "No participar"
        : "Participar con precaución";
    data.conclusion = data.conclusion.trim() + ` Recomendación: ${suffix}`;
  }

  data.tipo = tipo;
  return data;
}

// ─── FALLBACK ─────────────────────────────────────────────────────────────────
function buildFallback(tipo) {
  return {
    tipo,
    resumen: "No se pudo analizar de forma confiable. El motor de IA devolvió un formato inesperado.",
    licitacion: { nombre: "—", organismo: "—", objeto: "—", monto: "—", plazo_presentacion: "—", plazo_ejecucion: "—" },
    veredicto: "REVISAR",
    score: null,
    score_razon: null,
    requisitos: [],
    riesgos: ["El análisis automático falló — revisar manualmente el documento."],
    conclusion: "No fue posible completar el análisis automático. Recomendación: Participar con precaución",
  };
}

// ─── BUILD PROMPT ─────────────────────────────────────────────────────────────
function buildPrompt(tipo, empresa) {
  const ctx = empresa
    ? `CONTEXTO DE EMPRESA:
Nombre: ${empresa.nombre} | Sector: ${empresa.sector} | Facturación: ${empresa.facturacion}
Empleados: ${empresa.empleados || "N/E"} | Certificaciones: ${empresa.certificaciones || "ninguna"}
Experiencia: ${empresa.experiencia || "no especificada"} | Capacidades: ${empresa.capacidades || "no especificadas"}
Historial: ${empresa.historial || "sin historial"}
INSTRUCCIÓN CRÍTICA: Cruza CADA requisito con las capacidades reales de esta empresa.`
    : "Sin perfil de empresa. Análisis general.";

  const foco = {
    viabilidad: "viabilidad y conveniencia de presentarse a esta licitación",
    clausulas:  "cláusulas clave y condiciones contractuales",
    plazos:     "plazos, fechas críticas e hitos",
    financiero: "aspectos financieros, garantías y penalidades",
  }[tipo] || "contenido general de la licitación";

  return `Analiza el documento enfocándote en ${foco}.
${ctx}

Responde ÚNICAMENTE con este JSON. Sin texto antes, sin texto después, sin backticks.
Cada "texto_original" DEBE ser cita textual exacta del documento.
Cada "fuente" DEBE indicar sección, artículo o página. Si no existe, usar exactamente: "Fuente no identificada claramente".
La "conclusion" DEBE terminar con exactamente una de estas frases:
  "Recomendación: Participar"
  "Recomendación: Participar con precaución"  
  "Recomendación: No participar"

{
  "resumen": "string — resumen ejecutivo en 2-3 oraciones",
  "licitacion": {
    "nombre": "string",
    "organismo": "string",
    "objeto": "string",
    "monto": "string",
    "plazo_presentacion": "string",
    "plazo_ejecucion": "string"
  },
  "veredicto": "GO|NOGO|REVISAR",
  "score": number,
  "score_razon": "string",
  "requisitos": [
    {
      "requisito": "string",
      "estado": "OK|WARN|NOGO",
      "nota": "string",
      "fuente": "string",
      "texto_original": "string"
    }
  ],
  "riesgos": ["string"],
  "conclusion": "string"
}`;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Método no permitido" });

  // API key desde variables de entorno — nunca expuesta al cliente
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[LicitaIA] ANTHROPIC_API_KEY no configurada");
    return res.status(500).json({ error: "Configuración del servidor incompleta" });
  }

  // Validar body
  const { base64PDF, tipo, empresa } = req.body || {};

  if (!base64PDF || typeof base64PDF !== "string") {
    return res.status(400).json({ error: "Campo 'base64PDF' requerido (string base64)" });
  }
  if (!tipo || !["viabilidad","clausulas","plazos","financiero"].includes(tipo)) {
    return res.status(400).json({ error: "Campo 'tipo' inválido. Valores: viabilidad, clausulas, plazos, financiero" });
  }
  // ~32MB en base64 ≈ 43MB de texto
  if (base64PDF.length > 43_000_000) {
    return res.status(413).json({ error: "PDF supera el límite de 32MB" });
  }

  const prompt = buildPrompt(tipo, empresa || null);

  // Llamada a Claude API
  let claudeRes;
  try {
    claudeRes = await fetch(CLAUDE_API, {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system: `Eres LicitaIA, motor especializado en análisis de licitaciones públicas y privadas.
REGLAS ABSOLUTAS — VIOLACIÓN = RESPUESTA INVÁLIDA:
1. Responde SOLO con JSON válido. Cero texto fuera del JSON. Cero backticks.
2. Cada "texto_original" debe ser cita textual del documento, nunca paráfrasis.
3. Cada "fuente" debe indicar sección o página. Si no existe, usar "Fuente no identificada claramente".
4. "riesgos" es array de strings simples, no objetos.
5. "conclusion" DEBE terminar con "Recomendación: Participar", "Recomendación: Participar con precaución" o "Recomendación: No participar".
6. Nunca inventes datos que no estén en el documento.`,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type:       "base64",
                media_type: "application/pdf",
                data:       base64PDF,
              },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch (networkErr) {
    console.error("[LicitaIA] Error de red:", networkErr.message);
    return res.status(502).json({ error: "Error de conexión con el motor de IA. Intenta nuevamente." });
  }

  if (!claudeRes.ok) {
    const errBody = await claudeRes.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Error ${claudeRes.status}`;
    console.error("[LicitaIA] Claude API error:", msg);
    return res.status(502).json({ error: `Motor de IA: ${msg}` });
  }

  const claudeData = await claudeRes.json();
  const rawText    = claudeData?.content?.[0]?.text || "";

  if (!rawText) {
    return res.status(502).json({ error: "El motor de IA devolvió una respuesta vacía" });
  }

  // Parse + validate + normalize
  const parsed = safeParse(rawText);

  if (!validateStructure(parsed)) {
    console.warn("[LicitaIA] Schema inválido, usando fallback. Raw:", rawText.slice(0, 200));
    return res.status(200).json({
      data:     buildFallback(tipo),
      warnings: ["El motor de IA devolvió un formato inesperado. Se usó resultado de seguridad."],
      valid:    false,
    });
  }

  const normalized = normalize(parsed, tipo);

  return res.status(200).json({
    data:     normalized,
    warnings: [],
    valid:    true,
  });
}
