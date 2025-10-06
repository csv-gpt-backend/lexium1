// ===== Lexium API MIN — GPT-5 (Responses API) con JSON forzado =====
import express from "express";
import cors from "cors";
import compression from "compression";
import fs from "fs/promises";
import path from "path";
import http from "http";
import { Agent } from "undici";
import { fileURLToPath } from "url";

/* ---------- Config ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT            = process.env.PORT || 8080;
const STORAGE_DIR     = process.env.STORAGE_DIR || "/app/storage"; // decimo.csv + 3 txt
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_MODEL    = process.env.OPENAI_MODEL || "gpt-5";       // usa gpt-5
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors({ origin: "*" }));
app.use(compression());

/* ---------- Utiles ---------- */
function norm(s=""){ return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim(); }
function toNum(x){ const n = Number(String(x).replace(",", ".")); return Number.isFinite(n)?n:NaN; }

/* ---------- Lectura de datos ---------- */
async function loadCSV(name){
  const full = path.join(STORAGE_DIR, name);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { columns: [], rows: [] };
  const delim = lines[0].includes(";") ? ";" : ",";
  const columns = lines[0].split(delim).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const vals = l.split(delim).map(v => v.replace(/^"(.*)"$/, "$1").trim());
    const o={}; columns.forEach((h,i)=>o[h]=vals[i]??""); return o;
  });
  return { columns, rows };
}
async function readText(name){ try{ return await fs.readFile(path.join(STORAGE_DIR,name),"utf8"); }catch{ return ""; } }

/* ---------- Preload en memoria ---------- */
let DATA = { columns: [], rows: [] };
let TXT  = { emocionales:"", evaluacion:"", ubicacion:"" };

await fs.mkdir(STORAGE_DIR, { recursive: true });
try{
  const { columns, rows } = await loadCSV("decimo.csv");
  DATA = { columns, rows };
  TXT.emocionales = await readText("emocionales.txt");
  TXT.evaluacion  = await readText("evaluacion.txt");
  TXT.ubicacion   = await readText("ubicacion.txt");
  console.log(`📦 Preload OK: filas=${rows.length}, cols=${columns.length}`);
}catch(e){ console.log("⚠️ Preload falló:", String(e)); }

/* ---------- OpenAI (Responses API con text.format=json) ---------- */
const keepAlive = new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000 });

async function askGPT(systemPrompt, userPrompt, maxOut = 650) {
  const r = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,                // "gpt-5"
      reasoning: { effort: "low" },
      // 👇 Forzamos respuesta como JSON
      modalities: ["text"],
      text: { format: "json" },
      max_output_tokens: maxOut,
      input: [
        {
          role: "system",
          content: [{ type: "text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }]
        }
      ]
    }),
    dispatcher: keepAlive
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || r.statusText);

  // Preferimos output_text; si no viene, buscamos en la estructura
  return (
    data.output_text ||
    (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) ||
    "{}"
  );
}

/* ---------- Endpoints ---------- */
app.get("/api/ping", (_req,res)=>{
  res.json({ ok:true, model: OPENAI_MODEL, region: process.env.FLY_REGION || "?" });
});

app.get("/api/ask", async (req,res)=>{
  try{
    const q = String(req.query.q||"").trim();
    if (!q) return res.status(400).json({ ok:false, error:"missing_q" });

    const { columns, rows } = DATA;
    if (!rows.length) return res.json({ ok:true, general:"No hay datos en decimo.csv.", lists:[], tables:[] });

    const numericCols = columns.filter(c => rows.some(r => Number.isFinite(toNum(r[c]))));
    const nameCol  = columns.find(c=>norm(c)==="nombre")   || "NOMBRE";
    const parCol   = columns.find(c=>norm(c)==="paralelo") || "PARALELO";
    const cursoCol = columns.find(c=>norm(c)==="curso")    || "CURSO";

    // Contexto pequeño (muestra) válido para todo
    const keep = [nameCol, parCol, cursoCol, ...numericCols.slice(0,6)];
    const slim = rows.slice(0, 300).map(r => { const o={}; for (const c of keep) o[c]=r[c]; return o; });

    const systemPrompt = `
Devuelve SOLO un objeto JSON con esta forma exacta:
{
  "ok": true,
  "general": "texto",
  "lists": [ { "title":"", "items": [] } ],
  "tables": [ { "title":"", "columns": [], "rows": [] } ]
}
Usa el CSV provisto para cálculos (promedios, top, percentiles, filtros por CURSO/PARALELO) y los TXT para definiciones/interpretación.
No inventes. Español claro y breve.
`;

    const userPrompt = `Pregunta: ${q}
CSV (muestra): ${JSON.stringify({ columnas: keep, filas: slim })}
TXT: ${JSON.stringify({
  emocionales: (TXT.emocionales||"").slice(0,1600),
  evaluacion:  (TXT.evaluacion ||"").slice(0,1000),
  ubicacion:   (TXT.ubicacion  ||"").slice(0,800)
})}`;

    const out = await askGPT(systemPrompt, userPrompt, 700);
    const parsed = JSON.parse(out);

    res.json({
      ok: parsed.ok !== false,
      general: parsed.general || "",
      lists: Array.isArray(parsed.lists) ? parsed.lists : [],
      tables: Array.isArray(parsed.tables) ? parsed.tables : []
    });

  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

/* ---------- Start ---------- */
const server = http.createServer(app);
server.keepAliveTimeout = 10_000;
server.headersTimeout   = 12_000;
server.listen(PORT, ()=> console.log(`✅ Lexium MIN (GPT-5) @:${PORT}`));
