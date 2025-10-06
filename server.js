// ======================= Lexium API — GPT-5 FAST (Fly.io) =======================
// Performance features:
// • GPT-5 (Responses API), reasoning: low, max_output_tokens pequeño
// • Preload CSV/TXT en memoria (+ /api/reload) -> sin I/O por request
// • Router de intención: cálculos en servidor en ms; GPT-5 solo redacta/formatea
// • Contexto mínimo al modelo (fila única, resúmenes, o tablas ya calculadas)
// • Keep-Alive y compresión HTTP
// • Respuesta SIEMPRE JSON { ok, general, lists, tables }

import express from "express";
import cors from "cors";
import compression from "compression";
import fs from "fs/promises";
import path from "path";
import http from "http";
import { Agent } from "undici";
import { fileURLToPath } from "url";

// -------------------- Config --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT            = process.env.PORT || 8080;
const STORAGE_DIR     = process.env.STORAGE_DIR || "/app/storage"; // decimo.csv + 3 txt
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_MODEL    = process.env.OPENAI_MODEL || "gpt-5";
const MAX_OUT_TOKENS  = 450;     // salida acotada -> menos latencia
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 25000; // el back nunca tardará más de esto

// -------------------- App --------------------
const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors({ origin: "*" }));
app.use(compression());

// Keep-Alive a OpenAI
const keepAliveAgent = new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000 });

// -------------------- Utils --------------------
function norm(s = "") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function toNum(x) {
  const n = Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}
function mean(nums) {
  const vs = nums.map(toNum).filter(Number.isFinite);
  return vs.length ? vs.reduce((a,b)=>a+b,0) / vs.length : NaN;
}
function percentileOf(value, arrNums){
  const xs = arrNums.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length || !Number.isFinite(value)) return NaN;
  let i = 0; while (i<xs.length && xs[i] <= value) i++;
  return Math.round((i / xs.length) * 100);
}

// -------------------- Carga de archivos --------------------
async function loadCSV(name) {
  const full = path.join(STORAGE_DIR, name);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { columns: [], rows: [] };

  const delim = lines[0].includes(";") ? ";" : ",";
  const columns = lines[0].split(delim).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const vals = l.split(delim).map(v => v.replace(/^"(.*)"$/, "$1").trim());
    const o = {};
    columns.forEach((h,i) => o[h] = vals[i] ?? "");
    return o;
  });
  return { columns, rows };
}
async function readText(name) {
  try { return await fs.readFile(path.join(STORAGE_DIR, name), "utf8"); }
  catch { return ""; }
}

// -------------------- Preload en memoria + /api/reload --------------------
let DATA = { columns: [], rows: [] };
let TXT  = { emocionales: "", evaluacion: "", ubicacion: "" };

async function preloadAll() {
  const { columns, rows } = await loadCSV("decimo.csv");
  DATA = { columns, rows };
  TXT.emocionales = await readText("emocionales.txt");
  TXT.evaluacion  = await readText("evaluacion.txt");
  TXT.ubicacion   = await readText("ubicacion.txt");
  console.log(`📦 Preload: filas=${rows.length}, cols=${columns.length}, txt=[${[
    TXT.emocionales && "emocionales", TXT.evaluacion && "evaluacion", TXT.ubicacion && "ubicacion"
  ].filter(Boolean).join(", ")}]`);
}
await fs.mkdir(STORAGE_DIR, { recursive: true });
await preloadAll();

app.post("/api/reload", async (_req, res) => {
  try { await preloadAll(); res.json({ ok:true, rows: DATA.rows.length, cols: DATA.columns.length }); }
  catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// -------------------- Intent Router (rápido) --------------------
const RX = {
  reporte:   /reporte\s+completo\s+de\s+(.+)/i,
  percentil: /percentil\s+de\s+(.+?)\s+en\s+(.+)/i,
  promedio:  /\b(promedio|media)\b/i,
  top:       /\btop\s+(\d+)/i,
  umbral:    /(>=|=>|<=|=<|>|<)\s*(\d+)/
};

function keys(columns){
  return {
    name:  columns.find(c=>norm(c)==="nombre")   || "NOMBRE",
    par:   columns.find(c=>norm(c)==="paralelo") || "PARALELO",
    curso: columns.find(c=>norm(c)==="curso")    || "CURSO"
  };
}
function findByName(rows, nameCol, raw){
  const q = norm(raw);
  return rows.find(r => norm(r[nameCol])===q) || rows.find(r => norm(r[nameCol]).includes(q));
}
function numericCols(columns, rows){
  return columns.filter(c => rows.some(r => Number.isFinite(toNum(r[c]))));
}
function pickMentionedNumeric(q, columns, rows){
  const n = norm(q);
  const nums = numericCols(columns, rows);
  const mentioned = nums.filter(c => n.includes(norm(c)));
  return mentioned.length ? mentioned : nums.slice(0, 4);
}

// -------------------- OpenAI (Responses API) --------------------
async function askGPT(systemPrompt, userPrompt, maxOut = MAX_OUT_TOKENS) {
  const r = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,                // gpt-5
      reasoning: { effort: "low" },       // latencia baja
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

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS){
  return new Promise((resolve, reject) => {
    const t = setTimeout(()=>reject(new Error("timeout")), ms);
    promise.then(v=>{ clearTimeout(t); resolve(v); })
           .catch(e=>{ clearTimeout(t); reject(e); });
  });
}

// -------------------- Endpoints --------------------
app.get("/api/ping", (_req, res) => {
  res.json({ ok:true, model: OPENAI_MODEL, region: process.env.FLY_REGION || "?" });
});

// === /api/ask: intenta resolver en servidor y usa GPT-5 para explicar/formatear ===
app.get("/api/ask", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok:false, error:"missing_q" });

    const { columns, rows } = DATA;
    if (!rows.length) return res.json({ ok:true, general:"No hay datos en decimo.csv.", lists:[], tables:[] });

    const { name, par, curso } = keys(columns);

    // ---------- INTENCIÓN: REPORTE COMPLETO ----------
    if (RX.reporte.test(q)) {
      const person = q.match(RX.reporte)[1].trim();
      const row = findByName(rows, name, person);
      if (!row) {
        // sugerencias: solo nombres (rápido)
        const names = rows.slice(0, 300).map(r => r[name]).filter(Boolean);
        const out = {
          tipo: "reporte_no_encontrado",
          person,
          sugerencias: names.slice(0, 30)
        };
        const systemPrompt = `Devuelve SOLO JSON {ok,general,lists,tables}.`;
        const userPrompt = `El usuario pidió un reporte de "${person}" pero no se encontró. Sugiérele 5 alternativas de la lista (si las hay) y un mensaje amable.\nLista de nombres:\n${JSON.stringify(names.slice(0,100))}\n`;
        const text = await withTimeout(askGPT(systemPrompt, userPrompt, 300), 8000);
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
        return res.json(parsed || { ok:true, general:`No encontré a "${person}".`, lists:[{title:"Sugerencias",items:names.slice(0,5)}], tables:[] });
      }

      // fila única + extractos TXT -> mínimo contexto
      const context = {
        alumno: row,
        columnas: Object.keys(row),
        txt: {
          emocionales: (TXT.emocionales||"").slice(0, 1500),
          evaluacion:  (TXT.evaluacion ||"").slice(0, 1000),
          ubicacion:   (TXT.ubicacion  ||"").slice(0, 800)
        }
      };
      const systemPrompt = `
Eres Lexium. Devuelve SOLO JSON {"ok":true,"general":"","lists":[...],"tables":[...]}.
Genera un informe breve y claro con 2 tablas:
- "Dominios/Habilidades" (col: Nombre, Valor) a partir de las columnas numéricas del alumno.
- "Datos básicos" (NOMBRE, CURSO, PARALELO).
No inventes datos. Español neutro. Sin diagnósticos.`;
      const userPrompt = `Pregunta: ${q}\nDatos:\n${JSON.stringify(context)}`;
      const text = await withTimeout(askGPT(systemPrompt, userPrompt, 450), 12000);
      let parsed; try { parsed = JSON.parse(text); } catch { const m=text.match(/\{[\s\S]*\}$/); parsed = m?JSON.parse(m[0]):null; }
      return res.json(parsed || { ok:true, general:`Informe de ${row[name]}`, lists:[], tables:[] });
    }

    // ---------- INTENCIÓN: PERCENTIL ----------
    if (RX.percentil.test(q)) {
      const [, personRaw, metricRaw] = q.match(RX.percentil);
      const metric = pickMentionedNumeric(metricRaw, columns, rows)[0];
      if (!metric) return res.json({ ok:true, general:"No identifiqué la métrica.", lists:[], tables:[] });
      const row = findByName(rows, name, personRaw);
      if (!row) return res.json({ ok:true, general:`No encontré a "${personRaw}".`, lists:[], tables:[] });

      const cohort = rows.map(r => toNum(r[metric])).filter(Number.isFinite);
      const val = toNum(row[metric]);
      const p = percentileOf(val, cohort);

      const payload = {
        tipo: "percentil",
        alumno: { nombre: row[name], [curso]: row[curso], [par]: row[par] },
        metrica: metric,
        valor: Number.isFinite(val)?val:null,
        percentil: Number.isFinite(p)?p:null
      };
      const systemPrompt = `Devuelve SOLO JSON {ok,general,lists,tables}. Redacta una explicación breve (2-3 líneas) del percentil y una tabla con [Alumno, Paralelo, Curso, Métrica, Valor, Percentil].`;
      const userPrompt = `Datos ya calculados:\n${JSON.stringify(payload)}`;
      const text = await withTimeout(askGPT(systemPrompt, userPrompt, 320), 8000);
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
      return res.json(parsed || {
        ok:true,
        general:`${row[name]}: ${metric}=${val} (P${p}).`,
        lists:[],
        tables:[{title:"Detalle", columns:["Alumno",par,curso,"Métrica","Valor","Percentil"], rows:[[row[name],row[par],row[curso],metric,val,p]]}]
      });
    }

    // ---------- INTENCIÓN: PROMEDIOS / TOP / UMBRAL ----------
    if (RX.promedio.test(q) || RX.top.test(q) || RX.umbral.test(q)) {
      const nums = pickMentionedNumeric(q, columns, rows);
      const mcol = nums[0];
      if (!mcol) return res.json({ ok:true, general:"No identifiqué la métrica.", lists:[], tables:[] });

      // filtros opcionales curso/paralelo en el texto
      const mPar = q.match(/paralelo\s+([A-Za-z0-9]+)/i);
      const mCur = q.match(/curso\s+([A-Za-zÁÉÍÓÚÜÑ0-9]+)/i);
      const f = {};
      if (mPar) f[par] = String(mPar[1]).toUpperCase();
      if (mCur) f[curso] = norm(mCur[1]).toUpperCase();

      const base = rows.filter(r => Object.keys(f).every(k => norm(String(r[k])) === norm(String(f[k]))));
      const numeric = base.map(r => ({ n:r[name], par:r[par], cur:r[curso], v: toNum(r[mcol]) })).filter(x => Number.isFinite(x.v));

      let calc = { tipo:"promedio/top/umbral", filtro:f, metrica:mcol };
      let table = null;

      // TOP
      const mTop = q.match(RX.top);
      if (mTop) {
        const k = Math.max(1, Math.min(50, parseInt(mTop[1],10)));
        const asc = /\b(mas baja|más baja|menor|minimo|mínimo|peores)\b/i.test(q);
        numeric.sort((a,b)=> asc ? a.v-b.v : b.v-a.v);
        const rowsOut = numeric.slice(0, k).map(x => [x.n, x.par, x.cur, x.v]);
        table = { title: `Top ${k} por ${mcol}${asc?" (más baja)":" (más alta)"}${Object.keys(f).length?" (filtrado)":""}`, columns:[name, par, curso, mcol], rows: rowsOut };
        calc.mode = "top"; calc.k = k; calc.asc = asc;
      }

      // PROMEDIO (si no hubo top ya)
      if (!table && RX.promedio.test(q)) {
        // por paralelo si lo piden
        const porPar = /\bpor\s+paralelo\b/i.test(q);
        const porCurso = /\bpor\s+curso\b/i.test(q);
        if (porPar || porCurso) {
          const key = porPar ? "par" : "cur";
          const titleKey = porPar ? par : curso;
          const groups = new Map();
          for (const r of numeric) {
            const g = r[key]; if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(r.v);
          }
          const rowsOut = [...groups.entries()]
            .map(([g, arr]) => [g, Number.isFinite(mean(arr)) ? Math.round(mean(arr)*10)/10 : "—"])
            .sort((a,b)=> String(a[0]).localeCompare(String(b[0])));
          table = { title:`Promedio de ${mcol} por ${titleKey}${Object.keys(f).length?" (filtrado)":""}`, columns:[titleKey,"Promedio"], rows: rowsOut };
          calc.mode = "promedio_grupo";
        } else {
          const avg = mean(numeric.map(x=>x.v));
          table = { title:`Promedio de ${mcol}${Object.keys(f).length?" (filtrado)":""}`, columns:["Métrica","Promedio"], rows:[[mcol, Number.isFinite(avg)?Math.round(avg*10)/10:"—"]] };
          calc.mode = "promedio";
        }
      }

      // UMBRAL
      if (!table && RX.umbral.test(q)) {
        const [, op, valRaw] = q.match(RX.umbral);
        const val = Number(valRaw);
        const pass = (x) => (op === ">") ? x>val : (op === "<") ? x<val : (op === ">=") ? x>=val : x<=val;
        const rowsOut = numeric.filter(x => pass(x.v)).sort((a,b)=> b.v-a.v).slice(0, 200).map(x => [x.n, x.par, x.cur, x.v]);
        table = { title:`Listado por umbral (${mcol} ${op} ${val})${Object.keys(f).length?" (filtrado)":""}`, columns:[name,par,curso,mcol], rows: rowsOut };
        calc.mode = "umbral"; calc.op = op; calc.val = val;
      }

      // Si nada anterior armó tabla, devolvemos base mínima
      if (!table) table = { title:`Resultados`, columns:[name,par,curso,mcol], rows: numeric.slice(0,50).map(x=>[x.n,x.par,x.cur,x.v]) };

      // Pedimos a GPT-5 SOLO redactar breve JSON a partir de la tabla
      const systemPrompt = `Devuelve SOLO JSON {ok,general,lists,tables}. Redacta "general" en 1–2 líneas explicando la tabla. No inventes.`;
      const userPrompt = `Consulta: ${q}\nResumen calculado (JSON):\n${JSON.stringify({ calc, table })}`;
      const text = await withTimeout(askGPT(systemPrompt, userPrompt, 320), 7000);
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
      return res.json(parsed || { ok:true, general: table.title, lists:[], tables:[table] });
    }

    // ---------- Fallback: muestra pequeña + definiciones ----------
    {
      const keep = [name, par, curso, ...numericCols(columns, rows).slice(0,4)];
      const slim = rows.slice(0, 200).map(r => {
        const o={}; for (const c of keep) o[c]=r[c]; return o;
      });
      const context = {
        csv: { columnas: keep, filas: slim },
        txt: {
          emocionales: (TXT.emocionales||"").slice(0, 1600),
          evaluacion:  (TXT.evaluacion ||"").slice(0, 1000),
          ubicacion:   (TXT.ubicacion  ||"").slice(0, 800)
        }
      };
      const systemPrompt = `Devuelve SOLO JSON {ok,general,lists,tables}. Resume y responde con claridad sin inventar.`;
      const userPrompt = `Pregunta: ${q}\nDatos:\n${JSON.stringify(context)}`;
      const text = await withTimeout(askGPT(systemPrompt, userPrompt, 380), 10000);
      let parsed; try { parsed = JSON.parse(text); } catch { const m=text.match(/\{[\s\S]*\}$/); parsed = m?JSON.parse(m[0]):null; }
      return res.json(parsed || { ok:true, general:"Consulta procesada.", lists:[], tables:[] });
    }

  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// -------------------- Start con keep-alive --------------------
const server = http.createServer(app);
server.keepAliveTimeout = 10_000;
server.headersTimeout   = 12_000;
server.listen(PORT, () => {
  console.log(`✅ Lexium FAST (GPT-5) en puerto ${PORT} — región ${process.env.FLY_REGION || "?"}`);
});
