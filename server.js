// ===== Lexium API — GPT-5 (Responses API) con JSON forzado + fallback =====
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
const STORAGE_DIR     = process.env.STORAGE_DIR || "/app/storage";
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_MODEL    = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors({ origin: "*" }));
app.use(compression());

/* ---------- Utils ---------- */
function norm(s=""){ return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim(); }
function toNum(x){ const n = Number(String(x).replace(",", ".")); return Number.isFinite(n)?n:NaN; }

/* ---------- Carga de datos ---------- */
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
      model: OPENAI_MODEL,           // gpt-5
      reasoning: { effort: "low" },
      modalities: ["text"],
      text: { format: "json" },      // <- fuerza salida JSON
      max_output_tokens: maxOut,
      input: [
        { role: "system", content: [{ type: "]()
