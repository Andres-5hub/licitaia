// pages/api/licitaciones.js
// Scraper con Puppeteer para licitaciones vigentes de CompraNet Sonora v2
// Backend API real: https://compranetv2_2.sonora.gob.mx

import puppeteer from "puppeteer";

export const config = {
  api: { responseLimit: "10mb" },
};

const PORTAL_URL = "https://compranetv2.sonora.gob.mx/inicio/portal-licitaciones";
const API_BASE   = "compranetv2_2.sonora.gob.mx";

// ── normalización de campos API ───────────────────────────────────────────────
function fmtFecha(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? str : d.toISOString().slice(0, 10);
}

function normalizeApiRow(d, i) {
  return {
    id:               String(d.id || d.numeroProcedimiento || i),
    numero:           d.numeroProcedimiento || d.numero || "—",
    titulo:           d.descripcionProcedimiento || d.titulo || d.concepto || d.nombre || "—",
    dependencia:      d.unidadCompradora?.nombre || d.dependencia || d.organismo || "—",
    fechaPublicacion: fmtFecha(d.fechaPublicacion || d.fechaCreacion || d.createdAt),
    fechaLimite:      fmtFecha(d.fechaLimite || d.fechaCierre || d.fechaPresentacion),
    estatus:          d.estatus?.descripcion || d.estatus || d.status || "Vigente",
    modalidad:        d.tipoModalidad?.descripcion || d.modalidad || "—",
    tipo:             d.tipoProcedimiento?.descripcion || d.tipo || "—",
    monto:            d.montoMaximo || d.montoEstimado || d.monto || null,
  };
}

function normalizeDomRow(r, i) {
  return {
    id:               `dom-${i}`,
    numero:           r.numero  || "—",
    titulo:           r.titulo  || "—",
    dependencia:      r.dependencia  || "—",
    fechaPublicacion: r.fechaPublicacion || null,
    fechaLimite:      r.fechaLimite || null,
    estatus:          r.estatus || "Vigente",
    modalidad:        "—",
    tipo:             "—",
    monto:            null,
  };
}

// ── handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials",
      ],
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });

    // ── Interceptar respuestas JSON del backend real ────────────────────────
    let captured = null;

    page.on("response", async (response) => {
      if (captured) return;
      const url = response.url();
      if (!url.includes(API_BASE)) return;
      if (!response.ok()) return;

      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json")) return;

      try {
        const json = await response.json();
        // El backend devuelve { datos: [...], mensaje: "..." }
        const arr =
          json?.datos      ||
          json?.data       ||
          json?.results    ||
          json?.licitaciones ||
          (Array.isArray(json) ? json : null);

        if (arr && arr.length > 0) {
          captured = arr;
        }
      } catch {
        // respuesta no parseable, ignorar
      }
    });

    // ── Navegar al portal público ───────────────────────────────────────────
    await page.goto(PORTAL_URL, {
      waitUntil: "networkidle2",
      timeout:   30000,
    });

    // Dar tiempo a Angular para renderizar y hacer sus peticiones XHR
    await new Promise((r) => setTimeout(r, 4000));

    // ── Si capturamos datos del API, devolverlos ────────────────────────────
    if (captured && captured.length > 0) {
      return res.status(200).json({
        licitaciones: captured.map(normalizeApiRow),
        fuente:       "api",
        total:        captured.length,
        timestamp:    new Date().toISOString(),
      });
    }

    // ── Fallback: scraping del DOM ──────────────────────────────────────────
    const domRows = await page.evaluate(() => {
      const out = [];

      // Estrategia 1 – tabla Bootstrap estándar
      const tbodyRows = document.querySelectorAll("table tbody tr");
      if (tbodyRows.length > 0) {
        tbodyRows.forEach((tr) => {
          const tds = tr.querySelectorAll("td");
          if (tds.length < 2) return;
          out.push({
            numero:           tds[0]?.innerText?.trim() || "—",
            titulo:           tds[1]?.innerText?.trim() || "—",
            dependencia:      tds[2]?.innerText?.trim() || "—",
            fechaPublicacion: tds[3]?.innerText?.trim() || null,
            fechaLimite:      tds[4]?.innerText?.trim() || null,
            estatus:          tds[5]?.innerText?.trim() || "Vigente",
          });
        });
      }

      // Estrategia 2 – tarjetas con clases Angular/Bootstrap
      if (out.length === 0) {
        const cards = document.querySelectorAll(
          ".card, [class*='licitacion'], [class*='procedimiento'], app-licitacion, app-procedimiento"
        );
        cards.forEach((el, i) => {
          const txt = el.innerText?.trim();
          if (!txt || txt.length < 15) return;
          // intentar extraer campos con sub-selectores comunes
          const num  = el.querySelector("[class*='numero'], [class*='number']")?.innerText?.trim();
          const tit  = el.querySelector("[class*='titulo'], [class*='titulo'], h5, h6, strong")?.innerText?.trim();
          const dep  = el.querySelector("[class*='depend'], [class*='unidad']")?.innerText?.trim();
          const fech = el.querySelector("[class*='fecha'], time")?.innerText?.trim();
          const est  = el.querySelector("[class*='estatus'], [class*='status'], .badge")?.innerText?.trim();
          out.push({
            numero:           num  || `${i + 1}`,
            titulo:           tit  || txt.slice(0, 120),
            dependencia:      dep  || "—",
            fechaPublicacion: fech || null,
            fechaLimite:      null,
            estatus:          est  || "Vigente",
          });
        });
      }

      // Estrategia 3 – buscar cualquier lista de procedimientos visibles
      if (out.length === 0) {
        const items = document.querySelectorAll("li, .item, .row [class*='col']");
        let count = 0;
        items.forEach((el) => {
          if (count >= 30) return;
          const txt = el.innerText?.trim();
          if (txt && txt.length > 30 && txt.length < 500) {
            out.push({
              numero:           `${count + 1}`,
              titulo:           txt.slice(0, 200),
              dependencia:      "—",
              fechaPublicacion: null,
              fechaLimite:      null,
              estatus:          "Vigente",
            });
            count++;
          }
        });
      }

      return out;
    });

    if (domRows.length > 0) {
      return res.status(200).json({
        licitaciones: domRows.map(normalizeDomRow),
        fuente:       "dom",
        total:        domRows.length,
        timestamp:    new Date().toISOString(),
      });
    }

    // ── Sin datos: devolver vacío con mensaje ───────────────────────────────
    return res.status(200).json({
      licitaciones: [],
      fuente:       "empty",
      total:        0,
      timestamp:    new Date().toISOString(),
      mensaje:      "No se encontraron licitaciones vigentes en el portal en este momento.",
    });

  } catch (err) {
    console.error("[licitaciones] Error:", err.message);
    return res.status(500).json({
      error:   "Error al obtener licitaciones",
      detalle: err.message,
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}
