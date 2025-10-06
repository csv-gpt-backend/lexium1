// ======================= Lexium API GPT-5 =======================
import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lexium123";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim());
const STORAGE_DIR = process.env.STORAGE_DIR || "/app/storage";

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors());

// ======================= Helpers =======================
function norm(s = "") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function toNum(x) {
  const n = Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}
async function readText(name) {
  const p = path.join(STORAGE_DIR, name);
  try { return await fs.readFile(p, "utf8"); } catch { return ""; }
}
async function loadCSV(name) {
  const full = path.join(STORAGE_DIR, name);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { columns: [], rows: [] };
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(delimiter).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const vals = l.split(delimiter).map(v => v.replace(/^"(.*)"$/, "$1").trim());
    const o = {};
    headers.forEach((h, i) => (o[h] = vals[i]));
    return o;
  });
  return { columns: headers, rows };
}

// ======================= GPT-5 Universal =======================
async function askGPT(systemPrompt, userPrompt) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning: { effort: "medium" },
      max_output_tokens: 1500,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || resp.statusText);
  return data.output_text || "";
}

// ======================= API /api/ask =======================
app.get("/api/ask", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "missing_q" });

    // Lee CSV y TXT
    const { columns, rows } = await loadCSV("decimo.csv");
    if (!rows.length) return res.json({ ok: true, general: "No hay datos en decimo.csv.", lists: [], tables: [] });
    const emocionales = await readText("emocionales.txt");
    const evaluacion = await readText("evaluacion.txt");
    const ubicacion = await readText("ubicacion.txt");

    // Prepara contexto resumido
    const numericCols = columns.filter(c => rows.some(r => Number.isFinite(toNum(r[c]))));
    const safeRows = rows.slice(0, 300); // máximo 300 filas para demo

    const context = {
      csv: { columnas: columns, numericas: numericCols, filas: safeRows },
      txt: {
        emocionales: emocionales.slice(0, 2000),
        evaluacion: evaluacion.slice(0, 2000),
        ubicacion: ubicacion.slice(0, 2000)
      }
    };

    const systemPrompt = `
Eres el Asistente Lexium, especializado en análisis educativo.
Tienes acceso a un CSV con datos de estudiantes y a varios TXT con definiciones y observaciones.
Responde SIEMPRE en español y SOLO con este formato JSON exacto:
{
  "ok": true,
  "general": "texto breve de respuesta",
  "lists": [ { "title": "título", "items": ["", ""] } ],
  "tables": [ { "title": "título", "columns": ["", ""], "rows": [["",""]] } ]
}
Reglas:
- Usa los datos del CSV para cálculos (promedios, rankings, percentiles, comparaciones, filtros).
- Usa los TXT para análisis, interpretación o definiciones.
- No inventes datos que no existan.
- Si la pregunta es de un alumno (ej: "reporte de X"), genera una tabla y descripción.
- Lenguaje: formal, claro, respetuoso, sin diagnóstico clínico.
`;

    const userPrompt = `
Pregunta del usuario:
${q}

Datos disponibles:
${JSON.stringify(context, null, 2)}

Debes responder SOLO con JSON válido, siguiendo el formato especificado.
`;

    const out = await askGPT(systemPrompt, userPrompt);

    let parsed;
    try { parsed = JSON.parse(out); }
    catch {
      const m = out.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) throw new Error("La respuesta de GPT-5 no fue JSON válido.");

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ======================= Rutas auxiliares =======================
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, model: OPENAI_MODEL, region: process.env.FLY_REGION || "?" });
});

// ======================= Inicia =======================
app.listen(PORT, () => console.log(`✅ Lexium API (GPT-5) en puerto ${PORT}`));
