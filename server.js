// ======================= Lexium API — GPT-5 (Fly.io) =======================
// Características:
// • Solo GPT-5 (Responses API) — sin temperature
// • Preload de CSV/TXT en memoria + /api/reload
// • Intención ligera: enviamos al modelo el mínimo contexto necesario
// • Keep-Alive a OpenAI + compresión HTTP
// • Respuesta SIEMPRE en JSON { ok, general, lists, tables }

import express from "express";
import cors from "cors";
import compression from "compression";
import fs from "fs/promises";
import path from "path";
import http from "http";
import { Agent } from "undici";
import { fileURLToPath } from "url";

/* ======================= Config ======================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT         = process.env.PORT || 8080;
const STORAGE_DIR  = process.env.STORAGE_DIR || "/app/storage"; // decimo.csv + 3 txt
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-5";     // GPT-5
const MAX_OUT_TOKENS = 900;                                      // salida acotada para latencia

await fs.mkdir(STORAGE_DIR, { recursive: true });

/* ======================= App ======================= */
const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors({ origin: "*" }));
app.use(compression());

/* ======================= Keep-Alive cliente OpenAI ======================= */
const keepAliveAgent = new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000 });

/* ======================= Helpers base ======================= */
function norm(s = "") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function toNum(x) {
  const n = Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

/* ======================= Lectura de archivos ======================= */
async function loadCSV(filename) {
  const full = path.join(STORAGE_DIR, filename);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { columns: [], rows: [] };

  const delimiter = lines[0].includes(";") ? ";" : ",";
  const columns = lines[0].split(delimiter).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const vals = l.split(delimiter).map(v => v.replace(/^"(.*)"$/, "$1").trim());
    const o = {};
    columns.forEach((h, i) => (o[h] = vals[i]));
    return o;
  });
  return { columns, rows };
}
async function readText(name) {
  try { return await fs.readFile(path.join(STORAGE_DIR, name), "utf8"); }
  catch { return ""; }
}

/* ======================= Cache en memoria + /api/reload ======================= */
let DATA = { columns: [], rows: [] };
let TXT  = { emocionales: "", evaluacion: "", ubicacion: "" };

async function preloadAll() {
  const { columns, rows } = await loadCSV("decimo.csv");
  DATA = { columns, rows };
  TXT.emocionales = await readText("emocionales.txt");
  TXT.evaluacion  = await readText("evaluacion.txt");
  TXT.ubicacion   = await readText("ubicacion.txt");
  console.log(`📦 Preload: filas=${rows.length}, columnas=${columns.length}, TXT=${[
    TXT.emocionales && "emocionales", TXT.evaluacion && "evaluacion", TXT.ubicacion && "ubicacion"
  ].filter(Boolean).join(",")}`);
}
await preloadAll();

app.post("/api/reload", async (_req, res) => {
  try { await preloadAll(); res.json({ ok:true, rows: DATA.rows.length, cols: DATA.columns.length }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e.message || e) }); }
});

/* ======================= Intenciones para “slim context” ======================= */
const RX = {
  reporte:   /reporte\s+completo\s+de\s+(.+)/i,
  percentil: /percentil\s+de\s+(.+?)\s+en\s+(.+)/i,
  promedio:  /\b(promedio|media)\b/i,
  top:       /\btop\s+\d+/i
};

function findByName(rows, columns, name) {
  const nameKey = columns.find(c => norm(c) === "nombre") || "NOMBRE";
  const q = norm(name);
  const hit = rows.find(r => norm(r[nameKey]) === q) || rows.find(r => norm(r[nameKey]).includes(q));
  return { row: hit, nameKey };
}
function pickNumericColsFor(text, columns, rows) {
  const ntext = norm(text);
  const mentioned = columns.filter(c => ntext.includes(norm(c)));
  const numerics = columns.filter(c => rows.some(r => Number.isFinite(toNum(r[c]))));
  return [...new Set([...mentioned, ...numerics])].slice(0, 6);
}

/* ======================= OpenAI (Responses API) ======================= */
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";

async function askGPT(systemPrompt, userPrompt, maxOut = MAX_OUT_TOKENS) {
  const r = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,                 // gpt-5
      reasoning: { effort: "low" },        // menor latencia; puedes subir a "medium" si quieres
      max_output_tokens: maxOut,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ]
    }),
    dispatcher: keepAliveAgent
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || r.statusText);
  return data.output_text || "";
}

/* ======================= Utilidad timeout ======================= */
const REQUEST_TIMEOUT_MS = 25_000;
function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(v => { clearTimeout(t); resolve(v); })
           .catch(e => { clearTimeout(t); reject(e); });
  });
}

/* ======================= Endpoints ======================= */
app.get("/api/ping", (_req, res) => {
  res.json({ ok:true, model: OPENAI_MODEL, region: process.env.FLY_REGION || "?" });
});

/* ======================= /api/ask (GPT-5) ======================= */
app.get("/api/ask", async (req, res) => {
  try {
    const qraw = String(req.query.q || "").trim();
    if (!qraw) return res.status(400).json({ ok:false, error: "missing_q" });

    const { columns, rows } = DATA;
    if (!rows.length) return res.json({ ok:true, general:"No hay datos en decimo.csv.", lists:[], tables:[] });

    // --- Construcción de contexto mínimo según intención ---
    const nameCol  = columns.find(c=>norm(c)==="nombre")   || "NOMBRE";
    const parCol   = columns.find(c=>norm(c)==="paralelo") || "PARALELO";
    const cursoCol = columns.find(c=>norm(c)==="curso")    || "CURSO";

    let keepCols = [];
    let slimRows = [];
    let note = "default";

    if (RX.reporte.test(qraw)) {
      const person = qraw.match(RX.reporte)[1].trim();
      const { row } = findByName(rows, columns, person);
      if (row) {
        keepCols = Object.keys(row);
        slimRows = [row];
        note = "reporte_fila_unica";
      } else {
        // no encontrado: enviamos lista de nombres para que sugiera
        keepCols = [nameCol];
        slimRows = rows.slice(0, 400).map(r => ({ [nameCol]: r[nameCol] }));
        note = "reporte_busqueda_nombres";
      }
    }
    else if (RX.percentil.test(qraw)) {
      const measureRaw = qraw.match(RX.percentil)[2];
      const mcol = pickNumericColsFor(measureRaw, columns, rows)[0] || columns[0];
      keepCols = [nameCol, parCol, cursoCol, mcol];
      slimRows = rows.slice(0, 600).map(r => ({ [nameCol]: r[nameCol], [parCol]: r[parCol], [cursoCol]: r[cursoCol], [mcol]: r[mcol] }));
      note = "percentil_cols_minimas";
    }
    else if (RX.promedio.test(qraw) || RX.top.test(qraw)) {
      const picks = pickNumericColsFor(qraw, columns, rows);
      keepCols = [nameCol, parCol, cursoCol, ...picks];
      slimRows = rows.slice(0, 600).map(r => {
        const o = {}; for (const c of keepCols) o[c] = r[c]; return o;
      });
      note = "agregados_cols_minimas";
    }
    else {
      // fallback: pequeño muestreo
      keepCols = [nameCol, parCol, cursoCol, ...columns.filter(c => c !== nameCol && c !== parCol && c !== cursoCol).slice(0, 10)];
      slimRows = rows.slice(0, 200).map(r => {
        const o = {}; for (const c of keepCols) o[c] = r[c]; return o;
      });
      note = "fallback_sample";
    }

    const numericCols = keepCols.filter(c => slimRows.some(r => Number.isFinite(toNum(r[c]))));

    const context = {
      csv: { columnas: keepCols, numericas: numericCols, filas: slimRows },
      txt: {
        emocionales: (TXT.emocionales || "").slice(0, 3000),
        evaluacion:  (TXT.evaluacion  || "").slice(0, 2000),
        ubicacion:   (TXT.ubicacion   || "").slice(0, 2000)
      },
      note // útil para diagnosticar en logs si hace falta
    };

    const systemPrompt = `
Eres Lexium. Devuelve SOLO JSON EXACTO con esta forma:
{"ok":true,"general":"","lists":[{"title":"","items":[]}],"tables":[{"title":"","columns":[],"rows":[]}]}
Reglas: usa CSV para cálculos (promedios, rankings, percentiles, filtros por CURSO/PARALELO, reportes por alumno);
usa TXT para definiciones/interpretación. No inventes datos. Español claro y respetuoso.
`;

    const userPrompt = `Pregunta del usuario:\n${qraw}\n\nDatos disponibles:\n${JSON.stringify(context, null, 2)}\n\nResponde SOLO con JSON válido.`;

    const out = await withTimeout(askGPT(systemPrompt, userPrompt, MAX_OUT_TOKENS), 25_000);

    let parsed;
    try { parsed = JSON.parse(out); }
    catch {
      const m = out.match(/\{[\s\S]*\}$/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || typeof parsed !== "object") {
      return res.json({
        ok: true,
        general: "No pude interpretar la salida del modelo. Reformula (ej.: 'reporte completo de Nombre Apellido', 'promedio de ASERTIVIDAD por PARALELO').",
        lists: [],
        tables: []
      });
    }

    res.json({
      ok: parsed.ok !== false,
      general: parsed.general || "",
      lists: Array.isArray(parsed.lists) ? parsed.lists : [],
      tables: Array.isArray(parsed.tables) ? parsed.tables : []
    });

  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

/* ======================= Start con keep-alive ======================= */
const server = http.createServer(app);
server.keepAliveTimeout = 10_000;
server.headersTimeout   = 12_000;
server.listen(PORT, () => {
  console.log(`✅ Lexium API (GPT-5) en puerto ${PORT} — región ${process.env.FLY_REGION || "?"}`);
});
