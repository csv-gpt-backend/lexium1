// server.js — Lexium API FINAL (GPT-5, CSV + 3 TXT)
import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const STORAGE_DIR = process.env.STORAGE_DIR || "/app/storage";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-5";

await fs.mkdir(STORAGE_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(cors({ origin: "*" }));

function toNum(x) {
  const n = Number(String(x).replace(",", ".").replace(/[^\d\.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

// ===== CSV / TXT =====
async function loadCSV(filename) {
  const full = path.join(STORAGE_DIR, filename);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { columns: [], rows: [] };

  const first = lines[0];
  const delim = first.includes(";") ? ";" : ",";
  const columns = first.split(delim).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const vals = l.split(delim);
    const obj = {};
    columns.forEach((h, i) => (obj[h] = vals[i] ?? ""));
    return obj;
  });
  return { columns, rows };
}

async function readText(name) {
  try {
    return await fs.readFile(path.join(STORAGE_DIR, name), "utf8");
  } catch {
    return "";
  }
}

// ====== /api/ping ======
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, model: "gpt-5", region: process.env.FLY_REGION || "?" });
});

// ====== /api/ask ======
app.get("/api/ask", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "missing_q" });

    // Lee datos
    const { columns, rows } = await loadCSV("decimo.csv");
    if (!rows.length)
      return res.json({
        ok: true,
        general: "No hay datos en decimo.csv.",
        lists: [],
        tables: []
      });

    const emocionales = await readText("emocionales.txt");
    const evaluacion = await readText("evaluacion.txt");
    const ubicacion = await readText("ubicacion.txt");

    // Contexto de datos
    const numericCols = columns.filter(c =>
      rows.some(r => Number.isFinite(toNum(r[c])))
    );
    const safeRows = rows.slice(0, 300);

    const context = {
      csv: { columnas: columns, numericas: numericCols, filas: safeRows },
      txt: {
        emocionales: emocionales.slice(0, 3000),
        evaluacion: evaluacion.slice(0, 2000),
        ubicacion: ubicacion.slice(0, 2000)
      }
    };

    const systemPrompt = `
Eres el asistente Lexium (modo demo).
Responde **solo en formato JSON** con esta estructura exacta:
{
 "ok": true,
 "general": "texto principal",
 "lists": [ { "title": "", "items": [""] } ],
 "tables": [ { "title": "", "columns": ["",""], "rows": [["",""]] } ]
}
Usa exclusivamente la información de los archivos CSV y TXT provistos.
NO inventes datos. Describe y razona solo con base en el contexto.
Si hay nombres parecidos, sugiere alternativas en "lists".
Todo en español. Sin texto fuera del JSON.
`;

    const userPrompt = `
Pregunta del usuario: ${q}
Datos disponibles:
${JSON.stringify(context, null, 2)}
`;

    const r = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`OpenAI error ${r.status}: ${txt}`);
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}$/);
      if (m) parsed = JSON.parse(m[0]);
    }

    if (!parsed)
      return res.json({
        ok: true,
        general:
          "No se pudo interpretar la respuesta del modelo. Reformula tu pregunta.",
        lists: [],
        tables: []
      });

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== START ======
app.listen(PORT, () =>
  console.log(`✅ Lexium API lista en puerto ${PORT} (GPT-5)`)
);
