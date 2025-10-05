// server.js (ESM) — Lexium API con GPT-5 sobre CSV/TXT
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

/* ====== Config & paths ====== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT         = process.env.PORT || 8080;
const STORAGE_DIR  = process.env.STORAGE_DIR || "/app/storage";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "lexium123";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",").map(s=>s.trim()).filter(Boolean);

await fs.mkdir(STORAGE_DIR, { recursive: true });

/* ====== OpenAI ====== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT || undefined,
});

/* ====== App ====== */
const app = express();
app.use(express.json({ limit: "4mb" }));

// CORS con comodines
function originMatches(origin, pattern) {
  if (pattern === "*") return true;
  const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp("^" + esc(pattern).replace(/\\\*/g, ".*") + "$");
  return rx.test(origin);
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // cURL/Postman
    const ok = CORS_ORIGINS.some(p => originMatches(origin, p));
    cb(null, ok);
  },
}));

// No cache
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

/* ====== Utils ====== */
const upload = multer({ storage: multer.memoryStorage() });

function norm(s=""){
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
}
function toNum(x){
  if (x===null || x===undefined) return NaN;
  const n = Number(String(x).replace(",",".").replace(/[^\d.\-]/g,""));
  return Number.isFinite(n) ? n : NaN;
}
function mean(nums){
  const vals = nums.map(toNum).filter(Number.isFinite);
  if (!vals.length) return NaN;
  return Math.round((vals.reduce((a,b)=>a+b,0)/vals.length)*10)/10;
}
async function readText(name){
  const p = path.join(STORAGE_DIR, name);
  try { return await fs.readFile(p, "utf8"); } catch { return ""; }
}
async function loadCSV(filename){
  const full = path.join(STORAGE_DIR, filename);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.replace(/\r/g,"").split("\n").filter(l=>l.trim().length).map(l=>l.replace(/\uFEFF/g,""));
  if (!lines.length) return { columns:[], rows:[], delimiter:"," };
  const first = lines[0];
  const delimiter = (first.split(";").length > first.split(",").length) ? ";" : ",";
  const headers = first.split(delimiter).map(h=>h.trim());
  const rows = lines.slice(1).map(l=>{
    const parts = l.split(delimiter).map(s=>s.replace(/^"(.*)"$/,"$1").trim());
    const obj = {}; headers.forEach((h,i)=> obj[h] = parts[i] ?? "");
    return obj;
  });

  // casteo heurístico a num
  for (const key of headers){
    const sample = rows.slice(0,25).map(r=>toNum(r[key])).filter(Number.isFinite);
    if (sample.length >= 3){
      for (const r of rows){
        const n = toNum(r[key]); if (Number.isFinite(n)) r[key] = n;
      }
    }
  }
  return { columns: headers, rows, delimiter };
}

/* ====== Guard Admin ====== */
function requireAdmin(req,res,next){
  if (!ADMIN_TOKEN) return res.status(500).json({ ok:false, error:"admin_token_not_set" });
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

/* ====== Archivos ====== */
app.get("/api/files", async (req,res)=>{
  try{
    const entries = await fs.readdir(STORAGE_DIR, { withFileTypes:true });
    const files = entries.filter(e=>e.isFile()).map(e=>e.name).sort();
    res.json({ ok:true, files });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});
app.post("/api/files/upload", requireAdmin, upload.array("files"), async (req,res)=>{
  try{
    if (!req.files?.length) return res.status(400).json({ ok:false, error:"no_files" });
    const saved = [];
    for (const f of req.files){
      const dest = path.join(STORAGE_DIR, f.originalname);
      await fs.writeFile(dest, f.buffer);
      saved.push(f.originalname);
    }
    res.json({ ok:true, saved });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});
app.delete("/api/files", requireAdmin, async (req,res)=>{
  try{
    const name = String(req.query.name||"");
    if (!name) return res.status(400).json({ ok:false, error:"missing_name" });
    await fs.unlink(path.join(STORAGE_DIR, name));
    res.json({ ok:true, deleted:name });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

/* ====== Ping ====== */
app.get("/api/ping", (req,res)=>{
  res.json({ ok:true, pong:"🏓", region: process.env.FLY_REGION || process.env.PRIMARY_REGION || "?" });
});

/* ====== Motor LLM (GPT-5) ====== */
function bucket(v){
  const n = toNum(v);
  if (!Number.isFinite(n)) return "—";
  if (n <= 40) return "BAJO";
  if (n <= 70) return "PROMEDIO";
  return "ALTO";
}

// Construye contexto compacto pero completo (tu dataset cabe completo)
async function buildContextForLLM(query){
  const csv = await loadCSV("decimo.csv");
  const txt_emoc = await readText("emocionales.txt");
  const txt_eval = await readText("evaluacion.txt");
  const txt_ubic = await readText("ubicacion.txt");

  // Enriquecemos con metadatos útiles para el modelo
  const meta = {
    reglas_percentil: "RANGO BAJO: 1-40, PROMEDIO: 41-70, ALTO: 71-100",
    claves: {
      nombre: csv.columns.find(h=>norm(h)==="nombre") || "NOMBRE",
      curso:  csv.columns.find(h=>norm(h)==="curso")  || "CURSO",
      paralelo: csv.columns.find(h=>norm(h)==="paralelo") || "PARALELO"
    }
  };

  // Para cálculo correcto de percentiles/promedios, damos TODA la matriz (dataset pequeño)
  return {
    query,
    columns: csv.columns,
    rows: csv.rows,
    textos: {
      emocionales: txt_emoc,
      evaluacion: txt_eval,
      ubicacion: txt_ubic,
    },
    meta
  };
}

async function answerWithGPT(context){
  const system = `
Eres un analista educativo. Responde SIEMPRE en ESPAÑOL y usando EXCLUSIVAMENTE los datos proporcionados en "columns", "rows" y "textos".
Devuelve SOLO un JSON con esta forma:
{
  "ok": true,
  "general": "texto breve inicial",
  "lists": [{"title":"...", "items":["..."]}],
  "tables": [{"title":"...", "columns":["..."], "rows":[["...", "..."]]}]
}
Reglas:
- Si piden "reporte" de un estudiante, genera un resumen con: IE Global y su rango (BAJO<=40, PROMEDIO 41-70, ALTO 71-100), top 5 fortalezas (>=71) y top 5 áreas de mejora (<=40), tabla de habilidades y de dominios usando las columnas disponibles.
- Si piden "top/bottom", "promedio", "percentil", "listar > 70", etc., CALCULA con la matriz "rows".
- No inventes columnas ni datos. Si algo no existe, explícalo en "general".
- Mantén tablas compactas y claras. No devuelvas texto fuera del JSON.
`;

  const user = {
    role: "user",
    content:
`PREGUNTA:
${context.query}

CSV_COLUMNS:
${JSON.stringify(context.columns)}

CSV_ROWS_JSON:
${JSON.stringify(context.rows)}

TEXTOS:
emocionales.txt (primeros 1200 chars):
${(context.textos.emocionales||"").slice(0,1200)}

evaluacion.txt (primeros 1000 chars):
${(context.textos.evaluacion||"").slice(0,1000)}

ubicacion.txt (primeros 600 chars):
${(context.textos.ubicacion||"").slice(0,600)}

META:
${JSON.stringify(context.meta)}

IMPORTANTE:
- Usa las filas de CSV para números, promedios, percentiles, rankings.
- Si la pregunta no especifica métrica, prioriza "PROMEDIO DE INTELIGENCIA EMOCIONAL" o "AUTOESTIMA" si existen.
- Percentiles deben calcularse contra TODAS las filas pertinentes (no un subconjunto).
- Responde SOLO con JSON válido.
`
  };

  const resp = await openai.chat.completions.create({
    model: "gpt-5",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      user
    ]
  });

  let text = resp.choices?.[0]?.message?.content || "{}";
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object") return json;
  } catch {}
  // fallback mínimo
  return { ok:true, general:"No pude estructurar la respuesta.", lists:[], tables:[] };
}

/* ====== /api/answer (todo pasa por GPT-5) ====== */
app.get("/api/answer", async (req,res)=>{
  try{
    const q = String(req.query.q||"").trim();
    if (!q) return res.json({ ok:true, general:"Escribe una pregunta.", lists:[], tables:[] });

    const ctx = await buildContextForLLM(q);
    const out = await answerWithGPT(ctx);

    // Sanitizar mínimamente para el front
    if (out && out.ok !== false) {
      out.ok = true;
      out.lists  = Array.isArray(out.lists)  ? out.lists  : [];
      out.tables = Array.isArray(out.tables) ? out.tables : [];
      return res.json(out);
    }
    res.json({ ok:true, general:"Sin resultados.", lists:[], tables:[] });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ====== /api/report (alias de answer cuando piden “reporte completo de …”) ====== */
app.get("/api/report", async (req,res)=>{
  try{
    const q = String(req.query.q||"").trim();
    const query = q && /reporte\s+completo\s+de\s+/i.test(q) ? q : `reporte completo de ${q}`;
    const ctx = await buildContextForLLM(query);
    const out = await answerWithGPT(ctx);
    if (out && out.ok !== false) {
      out.ok = true;
      out.lists  = Array.isArray(out.lists)  ? out.lists  : [];
      out.tables = Array.isArray(out.tables) ? out.tables : [];
      return res.json(out);
    }
    res.json({ ok:true, general:"Sin resultados.", lists:[], tables:[] });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ====== Start ====== */
app.listen(PORT, ()=>{
  console.log(`API ready on :${PORT}`);
});
