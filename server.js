// server.js (ESM) — Lexium API con /api/ask (GPT-5) sin temperature
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/* ================== Paths & Config ================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT         = process.env.PORT || 8080;
const STORAGE_DIR  = process.env.STORAGE_DIR || "/app/storage";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "lexium123";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",").map(s => s.trim()).filter(Boolean);

// ⚠️ Modelo por defecto ahora es GPT-5 “full” (no mini). Puedes override por secret OPENAI_MODEL.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
// Usamos Chat Completions sin temperature (GPT-5 lo rechaza si se manda)
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

await fs.mkdir(STORAGE_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "2mb" }));

// No cache
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

/* ================== CORS con comodines ================== */
function originMatches(origin, pattern) {
  if (pattern === "*") return true;
  const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp("^" + esc(pattern).replace(/\\\*/g, ".*") + "$");
  return rx.test(origin);
}
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = CORS_ORIGINS.some(p => originMatches(origin, p));
      cb(null, ok);
    },
  })
);

/* ================== Helpers base ================== */
const upload = multer({ storage: multer.memoryStorage() });

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function toNum(x) {
  if (x === null || x === undefined) return NaN;
  const n = Number(String(x).replace(",", ".").replace(/[^\d\.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
function mean(nums) {
  const vals = nums.map(toNum).filter(Number.isFinite);
  if (!vals.length) return NaN;
  return Math.round((vals.reduce((a,b)=>a+b,0)/vals.length) * 10) / 10;
}
function bucket(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return "—";
  if (n <= 40) return "BAJO";
  if (n <= 70) return "PROMEDIO";
  return "ALTO";
}
function by(arr, key) {
  const m = new Map();
  for (const r of arr) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/* ================== CSV & TXT ================== */
async function loadCSV(filename) {
  const full = path.join(STORAGE_DIR, filename);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw
    .replace(/\r/g,"")
    .split("\n")
    .filter(l => l.trim().length)
    .map(l => l.replace(/\uFEFF/g,""));
  if (!lines.length) return { columns: [], rows: [], delimiter: "," };

  const first = lines[0];
  const delimiter = (first.split(";").length > first.split(",").length) ? ";" : ",";
  const headers = first.split(delimiter).map(h => h.trim());

  const rows = lines.slice(1).map(l => {
    const parts = l.split(delimiter).map(s => s.replace(/^"(.*)"$/,"$1").trim());
    const obj = {};
    headers.forEach((h, i) => (obj[h] = parts[i] ?? ""));
    return obj;
  });

  // Casteo numérico heurístico
  for (const key of headers) {
    const sample = rows.slice(0, 25).map(r => toNum(r[key])).filter(Number.isFinite);
    if (sample.length >= 3) {
      for (const r of rows) {
        const n = toNum(r[key]);
        if (Number.isFinite(n)) r[key] = n;
      }
    }
  }

  return { columns: headers, rows, delimiter };
}
async function readText(name) {
  const p = path.join(STORAGE_DIR, name);
  try { return await fs.readFile(p, "utf8"); }
  catch { return ""; }
}

/* ================== Búsqueda por nombre ================== */
function tokenizeName(s) { return norm(s).split(/\s+/).filter(Boolean); }
function findBestStudent(rows, query) {
  const qn = norm(query);
  const nameKey = rows.length ? Object.keys(rows[0]).find(h=>norm(h)==="nombre") || "NOMBRE" : "NOMBRE";

  const exact = rows.find(r => norm(r[nameKey]) === qn);
  if (exact) return { student: exact, suggestions: [] };

  const qTok = tokenizeName(qn);
  const scored = rows.map(r => {
    const nTok = tokenizeName(r[nameKey] ?? "");
    const hits = qTok.reduce((acc, qt) => acc + (nTok.includes(qt) ? 1 : 0), 0);
    return { r, hits };
  }).filter(x => x.hits > 0);
  scored.sort((a,b)=> b.hits - a.hits || norm(a.r[nameKey]).length - norm(b.r[nameKey]).length);

  if (scored.length && scored[0].hits >= Math.min(qTok.length, 2)) {
    return { student: scored[0].r, suggestions: scored.slice(1,6).map(x=>x.r[nameKey]) };
  }
  return { student: null, suggestions: scored.slice(0,10).map(x=>x.r[nameKey]) };
}

/* ================== Guard de Admin ================== */
function isAdmin(req){ return req.headers["x-admin-token"] === ADMIN_TOKEN; }
function requireAdmin(req, res, next){
  if (!ADMIN_TOKEN) return res.status(500).json({ ok:false, error:"admin_token_not_set" });
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

/* ================== Intents helper ================== */
function has(nq, ...tokens){ return tokens.some(t => nq.includes(norm(t))); }
function pickMeasure(nq, columns){
  const direct = columns.find(h => nq.includes(norm(h)));
  if (direct) return direct;

  const map = [
    { syns:["ie","ie global","inteligencia emocional","promedio de inteligencia emocional"], col:"PROMEDIO DE INTELIGENCIA EMOCIONAL" },
    { syns:["intrapersonales"], col:"PROMEDIO DE HABILIDADES INTRAPERSONALES" },
    { syns:["interpersonales"], col:"PROMEDIO DE HABILIDADES INTERPERSONALES" },
    { syns:["vida"], col:"PROMEDIO DE HABILIDADES PARA LA VIDA" },
  ];
  for (const {syns,col} of map){
    if (syns.some(s => nq.includes(norm(s)))) {
      const real = columns.find(h => norm(h)===norm(col));
      if (real) return real;
    }
  }
  const firstNum = columns.find(h => Number.isFinite(toNum((globalThis.__sampleRow||{})[h])));
  return firstNum || columns[0];
}
function parseGroupKey(nq, cols){
  if (has(nq,"por paralelo","por cada paralelo","por los paralelos")) return cols.find(h=>norm(h)==="paralelo") || "PARALELO";
  if (has(nq,"por curso","por cada curso","por los cursos")) return cols.find(h=>norm(h)==="curso") || "CURSO";
  return null;
}
function parseGroupFilter(nq, cols){
  const parCol   = cols.find(h=>norm(h)==="paralelo") || "PARALELO";
  const cursoCol = cols.find(h=>norm(h)==="curso")    || "CURSO";
  const f = {};
  const mPar = nq.match(/paralelo\s+([a-z0-9]+)/i);
  if (mPar) f[parCol] = mPar[1].toUpperCase();
  const mCurso = nq.match(/curso\s+([a-záéíóúüñ0-9]+)/i);
  if (mCurso) f[cursoCol] = norm(mCurso[1]).toUpperCase(); // DECIMO
  return f;
}
function filterByObj(rows, f){
  const keys = Object.keys(f||{});
  if (!keys.length) return rows;
  return rows.filter(r => keys.every(k => norm(String(r[k])) === norm(String(f[k]))));
}
function parseTopBottom(nq){
  if (!nq.includes("top") && !has(nq,"ranking","mejores","peores")) return null;
  const m = nq.match(/top\s+(\d+)/); 
  const k = m? Math.max(1,Math.min(50,parseInt(m[1],10))) : 5;
  const desc = has(nq,"mas alta","más alta","mayor","maximo","máximo","mejores");
  const asc  = has(nq,"mas baja","más baja","menor","minimo","mínimo","peores");
  return { k, order: desc ? "desc" : asc ? "asc" : "desc" };
}
function parseThreshold(nq){
  const ops = [
    {re:/mayor\s+o\s+igual\s+a\s+(\d+)/, op:">="},
    {re:/menor\s+o\s+igual\s+a\s+(\d+)/, op:"<="},
    {re:/mayor\s+a\s+(\d+)/, op:">"},
    {re:/menor\s+a\s+(\d+)/, op:"<"},
    {re:/(>=|=>)\s*(\d+)/, op:">=", idx:2},
    {re:/(<=|=<)\s*(\d+)/, op:"<=", idx:2},
    {re:/(>|<)\s*(\d+)/, idx:2},
  ];
  for (const o of ops){
    const m = nq.match(o.re);
    if (m){
      const val = parseFloat(m[o.idx||1]);
      const op  = o.op || m[1];
      return { op, val };
    }
  }
  return null;
}
function passThreshold(v, thr){
  if (!thr) return true;
  const n = toNum(v); if (!Number.isFinite(n)) return false;
  switch (thr.op){
    case ">":  return n >  thr.val;
    case "<":  return n <  thr.val;
    case ">=": return n >= thr.val;
    case "<=": return n <= thr.val;
    default:   return true;
  }
}
function percentileOf(value, arrNums){
  const xs = arrNums.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length || !Number.isFinite(value)) return NaN;
  let rank = xs.findIndex(v => v > value);
  if (rank === -1) rank = xs.length;
  return Math.round((rank / xs.length) * 100);
}

/* ================== Resumen de alumno ================== */
function buildStudentReport(rows, columns, personRaw){
  const nameKey  = columns.find(h=>norm(h)==="nombre")   || "NOMBRE";
  const cursoKey = columns.find(h=>norm(h)==="curso")    || "CURSO";
  const parKey   = columns.find(h=>norm(h)==="paralelo") || "PARALELO";

  const { student, suggestions } = findBestStudent(rows, personRaw);
  if (!student) {
    return {
      ok:true,
      general:`No encontré a '${personRaw}' en decimo.csv.`,
      lists: suggestions.length ? [{ title:"¿Quizás te refieres a…?", items:suggestions }] : [],
      tables:[]
    };
  }

  const key = (name) => columns.find(h => norm(h) === norm(name)) || name;
  const K = {
    NOMBRE: nameKey,
    CURSO:  cursoKey,
    PARALELO: parKey,
    IE: key("PROMEDIO DE INTELIGENCIA EMOCIONAL"),
  };

  const DOMS = [
    "PROMEDIO DE HABILIDADES INTRAPERSONALES",
    "PROMEDIO DE HABILIDADES INTERPERSONALES",
    "PROMEDIO DE HABILIDADES PARA LA VIDA",
    "PROMEDIO DE INTELIGENCIA EMOCIONAL",
  ].map(key);
  const HABS = [
    "AUTOESTIMA",
    "ASERTIVIDAD",
    "CONCIENCIA DE LOS DEMÁS",
    "EMPATÍA",
    "MOTIVACIÓN",
    "COMPROMISO",
    "ADMINISTRACIÓN DEL TIEMPO",
    "TOMA DE DECISIONES",
    "LIDERAZGO",
  ].map(key);

  const nombre   = student[K.NOMBRE];
  const curso    = student[K.CURSO];
  const paralelo = student[K.PARALELO];
  const ie       = toNum(student[K.IE]);

  const pares = HABS
    .filter(h => student[h] !== undefined && student[h] !== "")
    .map(h => [h, toNum(student[h])])
    .filter(([, v]) => Number.isFinite(v));

  const fortalezas = pares.filter(([, v]) => v >= 71).sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([h,v])=>`${h}: ${v} (${bucket(v)})`);
  const mejoras    = pares.filter(([, v]) => v <= 40).sort((a,b)=>a[1]-b[1]).slice(0,5)
    .map(([h,v])=>`${h}: ${v} (${bucket(v)})`);

  const perfilRows = pares.sort((a,b)=>b[1]-a[1]).map(([h,v])=>[h, v, bucket(v)]);
  const domRows = DOMS.map(d => [d, toNum(student[d]), bucket(toNum(student[d]))]).filter(r=>Number.isFinite(r[1]));

  const general = `Informe socioemocional de ${nombre} (CURSO ${curso}, PARALELO ${paralelo}). IE Global: ${Number.isFinite(ie)?ie:"—"} (${bucket(ie)}).`;

  const lists = [];
  if (fortalezas.length) lists.push({ title:"Fortalezas destacadas", items:fortalezas });
  if (mejoras.length)    lists.push({ title:"Áreas de mejora prioritarias", items:mejoras });

  return {
    ok:true,
    general,
    tables: [
      { title:"Perfil por Habilidad", columns:["Habilidad","Puntaje","Rango"], rows:perfilRows },
      { title:"Dominios", columns:["Dominio","Puntaje","Rango"], rows:domRows },
    ],
    lists
  };
}

/* ================== API base ================== */
app.get("/api/ping", (req, res) => {
  res.json({ ok:true, pong:"🏓", region: process.env.FLY_REGION || process.env.PRIMARY_REGION || "?" });
});

// Archivos
app.get("/api/files", async (req, res)=>{
  try{
    const entries = await fs.readdir(STORAGE_DIR, { withFileTypes: true });
    const files = entries.filter(e=>e.isFile()).map(e=>e.name).sort();
    res.json({ ok:true, files });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});
app.post("/api/files/upload", requireAdmin, upload.array("files"), async (req,res)=>{
  try{
    if (!req.files?.length) return res.status(400).json({ ok:false, error:"no_files" });
    const saved = [];
    for (const f of req.files) {
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

// CSV debug (requiere admin)
app.get("/api/csv", requireAdmin, async (req,res)=>{
  try{
    const name = String(req.query.name||"decimo.csv");
    const { columns, rows, delimiter } = await loadCSV(name);
    res.json({ ok:true, delimiter, count: rows.length, columns, sample: rows.slice(0,5) });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// Autocompletar estudiantes
app.get("/api/students", async (req,res)=>{
  try{
    const { rows } = await loadCSV("decimo.csv");
    const q = String(req.query.q||"");
    const nameKey = rows.length ? Object.keys(rows[0]).find(h=>norm(h)==="nombre") || "NOMBRE" : "NOMBRE";
    if (!q) return res.json({ ok:true, count: rows.length, names: rows.map(r=>r[nameKey]).slice(0,200) });

    const qTok = tokenizeName(q);
    const names = rows
      .map(r=>r[nameKey])
      .map(n=>({n, score: tokenizeName(n).filter(t=>qTok.includes(t)).length}))
      .filter(x=>x.score>0)
      .sort((a,b)=> b.score - a.score || norm(a.n).length - norm(b.n).length)
      .map(x=>x.n);
    res.json({ ok:true, count: names.length, names: names.slice(0,100) });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

/* ============= /api/answer: reglas deterministas ============= */
app.get("/api/answer", async (req, res) => {
  try{
    const q  = String(req.query.q||"").trim();
    const nq = norm(q);

    const { rows, columns } = await loadCSV("decimo.csv");
    if (!rows.length) return res.json({ ok:true, general:"No hay filas en decimo.csv.", lists:[], tables:[] });
    globalThis.__sampleRow = rows[0];

    const nameKey  = columns.find(h=>norm(h)==="nombre")   || "NOMBRE";
    const parKey   = columns.find(h=>norm(h)==="paralelo") || "PARALELO";
    const cursoKey = columns.find(h=>norm(h)==="curso")    || "CURSO";

    // Reporte completo
    if (has(nq,"reporte completo de")){
      const person = q.replace(/.*reporte\s+completo\s+de\s+/i,"").trim();
      const result = buildStudentReport(rows, columns, person);
      return res.json(result);
    }

    // Muestra N filas
    {
      const m = nq.match(/muestra\s+(\d+)\s+filas/);
      if (m){
        const n = Math.max(1, Math.min(50, parseInt(m[1],10)));
        const measure = pickMeasure(nq, columns);
        const subsetCols = [nameKey, cursoKey, parKey];
        if (!subsetCols.includes(measure)) subsetCols.push(measure);
        const sample = rows.slice(0,n).map(r => subsetCols.map(c=>r[c]));
        return res.json({ ok:true, general:`Primeras ${n} filas.`, tables:[{title:"Muestra", columns:subsetCols, rows:sample}], lists:[] });
      }
    }

    // Promedios
    if (has(nq,"promedio","media")){
      const measure   = pickMeasure(nq, columns);
      const groupKey  = parseGroupKey(nq, columns);
      const filterObj = parseGroupFilter(nq, columns);
      const base      = filterByObj(rows, filterObj);

      if (!groupKey){
        const avg = mean(base.map(r => r[measure]));
        return res.json({
          ok:true,
          general:`Promedio de ${measure}${Object.keys(filterObj).length? " (filtrado)":""}.`,
          tables:[{ title:"Promedio", columns:["Métrica","Promedio"], rows:[[measure, isNaN(avg)?"—":avg]] }],
          lists:[]
        });
      }

      const groups = by(base, groupKey);
      const trows = [];
      for (const [gkey, arr] of groups) trows.push([gkey, isNaN(mean(arr.map(r=>r[measure])))?"—":mean(arr.map(r=>r[measure]))]);
      trows.sort((a,b)=> String(a[0]).localeCompare(String(b[0])));
      return res.json({
        ok:true,
        general:`Promedio de ${measure} por ${groupKey}${Object.keys(filterObj).length? " (filtrado)":""}.`,
        tables:[{title:`${groupKey}`, columns:[groupKey,"Promedio"], rows:trows}],
        lists:[]
      });
    }

    // Top/Bottom
    {
      const tb = parseTopBottom(nq);
      if (tb){
        const measure   = pickMeasure(nq, columns);
        const filterObj = parseGroupFilter(nq, columns);
        let data = filterByObj(rows, filterObj)
          .map(r => [r[nameKey], r[parKey], r[cursoKey], toNum(r[measure])])
          .filter(x => Number.isFinite(x[3]));
        data.sort((a,b)=> tb.order==="desc" ? (b[3]-a[3]) : (a[3]-b[3]));
        const head = [nameKey, parKey, cursoKey, measure];
        return res.json({
          ok:true,
          general:`Top ${tb.k} por ${measure}${tb.order==="asc"?" (más baja)": " (más alta)"}${Object.keys(filterObj).length? " (filtrado)":""}.`,
          tables:[{title:"Top", columns:head, rows:data.slice(0, tb.k)}],
          lists:[]
        });
      }
    }

    // Umbrales
    if (has(nq,"quien","quienes","lista","listar","muestrame","mostrar")){
      const thr = parseThreshold(nq);
      if (thr){
        const measure   = pickMeasure(nq, columns);
        const filterObj = parseGroupFilter(nq, columns);
        let data = filterByObj(rows, filterObj)
          .map(r => [r[nameKey], r[parKey], r[cursoKey], toNum(r[measure])])
          .filter(x => Number.isFinite(x[3]) && passThreshold(x[3], thr))
          .sort((a,b)=>b[3]-a[3]);
        const head = [nameKey, parKey, cursoKey, measure];
        return res.json({
          ok:true,
          general:`Listado por umbral (${measure} ${thr.op} ${thr.val})${Object.keys(filterObj).length? " (filtrado)":""}.`,
          tables:[{title:"Resultados", columns:head, rows:data.slice(0, 200)}],
          lists:[]
        });
      }
    }

    // Percentil
    if (has(nq,"percentil")){
      const m = nq.match(/percentil\s+de\s+(.+?)\s+en\s+(.+)/i);
      if (m){
        const personRaw = m[1].trim();
        const measRaw   = m[2].trim();
        const measure   = pickMeasure(norm(measRaw), columns);
        const filterObj = parseGroupFilter(nq, columns);
        const base      = filterByObj(rows, filterObj);

        const { student } = findBestStudent(base, personRaw);
        if (!student) return res.json({ ok:true, general:`No encontré a '${personRaw}'.`, lists:[], tables:[] });

        const val = toNum(student[measure]);
        const p   = percentileOf(val, base.map(r=>toNum(r[measure])));
        return res.json({
          ok:true,
          general:`Percentil de ${student[nameKey]} en ${measure}${Object.keys(filterObj).length? " (cohorte filtrada)":""}: ${Number.isFinite(p)?p:"—"}.`,
          tables:[{title:"Detalle", columns:["Alumno", "Paralelo", "Curso", "Métrica", "Valor", "Percentil"], rows:[[student[nameKey], student[parKey], student[cursoKey], measure, Number.isFinite(val)?val:"—", Number.isFinite(p)?p:"—"]]}],
          lists:[]
        });
      }
    }

    // TXT
    if (has(nq,"segun","según") && (has(nq,"emocionales txt","evaluacion txt","ubicacion txt"))){
      let fname = "emocionales.txt";
      if (has(nq,"evaluacion txt")) fname = "evaluacion.txt";
      if (has(nq,"ubicacion txt"))  fname = "ubicacion.txt";
      const txt = await readText(fname);
      if (!txt) return res.json({ ok:true, general:`No encontré ${fname} en storage.`, lists:[], tables:[] });
      return res.json({ ok:true, general: txt.slice(0,1200) + (txt.length>1200 ? " …" : ""), lists:[], tables:[] });
    }

    // Fallback
    return res.json({
      ok:true,
      general:"No entendí del todo. Ejemplos: “promedio de ASERTIVIDAD por PARALELO (en curso DECIMO)”, “top 5 en IE global (en paralelo B)”, “quienes tienen TIMIDEZ > 70 (en paralelo A)”, “percentil de Castillo D Julia en AUTOESTIMA (en curso DECIMO)”, “muestra 5 filas”.",
      lists:[], tables:[]
    });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ============= /api/report: perfil completo alumno ============= */
app.get("/api/report", async (req, res) => {
  try{
    const q  = String(req.query.q||"");
    const nq = norm(q);
    let person = q;
    const m = nq.match(/reporte\s+completo\s+de\s+(.+)/);
    if (m) person = q.slice(m.index + m[0].length).trim();

    const { rows, columns } = await loadCSV("decimo.csv");
    if (!rows.length) return res.json({ ok:true, general:"No hay datos en decimo.csv.", lists:[], tables:[] });

    const result = buildStudentReport(rows, columns, person);
    res.json(result);
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ========= GPT universal: /api/ask (sin temperature) ========= */
function trimTxt(s="", max=1800){
  s = String(s);
  return s.length>max ? (s.slice(0,max) + " …") : s;
}
async function callOpenAIJSON(systemPrompt, userPrompt, maxTokens = 1200){
  const r = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,     // gpt-5; sin temperature (usa default del modelo)
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ]
    })
  });
  if (!r.ok) {
    const text = await r.text().catch(()=> "");
    throw new Error(`OpenAI error ${r.status}: ${text || r.statusText}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

app.get("/api/ask", async (req, res) => {
  try{
    const q = String(req.query.q||"").trim();
    if (!q) return res.status(400).json({ ok:false, error:"missing_q" });

    const { columns, rows } = await loadCSV("decimo.csv");
    if (!rows.length) {
      return res.json({ ok:true, general:"No hay datos en decimo.csv.", lists:[], tables:[] });
    }
    const emocionales = await readText("emocionales.txt");
    const evaluacion  = await readText("evaluacion.txt");
    const ubicacion   = await readText("ubicacion.txt");

    const numericCols = columns.filter(c => rows.some(r => Number.isFinite(toNum(r[c]))));
    const safeRows = rows.map(r => {
      const o = {};
      for (const c of columns) o[c] = r[c];
      return o;
    });

    const systemPrompt = `
Eres el Asistente Lexium. Respondes en español con **este JSON exacto**:
{
  "ok": true,
  "general": "texto",
  "lists": [ { "title":"", "items":["",""] } ],
  "tables": [ { "title":"", "columns":["",""], "rows":[["",""]] } ]
}
REGLAS:
- Usa SOLO los datos provistos (CSV + TXT). No inventes.
- Para cálculos (promedios, rankings, percentiles, filtros por CURSO/PARALELO) usa las filas del CSV.
- Para definiciones/ficha técnica usa los TXT.
- Rangos: BAJO 1–40, PROMEDIO 41–70, ALTO 71–100.
- Sin diagnósticos clínicos. Describe hallazgos y orientaciones educativas.
- Devuelve SIEMPRE JSON válido (sin Markdown, sin texto fuera del JSON).
`;

    const context = {
      archivos: {
        csv: {
          nombre: "decimo.csv",
          columnas: columns,
          columnas_numericas: numericCols,
          filas: safeRows
        },
        txt: {
          emocionales: trimTxt(emocionales, 3000),
          evaluacion:  trimTxt(evaluacion,  2000),
          ubicacion:   trimTxt(ubicacion,   1200)
        }
      },
      rangos: { bajo:"1-40", promedio:"41-70", alto:"71-100" },
      notas: [
        "CURSO y PARALELO identifican la cohorte.",
        "NOMBRE identifica a la persona.",
        "Si piden 'reporte', arma un perfil completo del estudiante.",
        "Si piden top/bottom, ordena por la métrica.",
        "Si piden promedio por grupo, agrupa por CURSO/PARALELO según corresponda."
      ]
    };

    const userPrompt = `
Pregunta del usuario:
${q}

Datos disponibles (JSON):
${JSON.stringify(context, null, 2)}

INSTRUCCIONES DE SALIDA:
- Responde **solo** con JSON.
- Si la consulta es por alumno, identifica por NOMBRE (búsqueda aproximada).
- Si hay ambigüedad, sugiere alternativas (2–5) en "lists".
`;

    const raw = await callOpenAIJSON(systemPrompt, userPrompt, 1400);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}$/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || typeof parsed !== "object") {
      return res.json({
        ok:true,
        general:"No pude interpretar la salida del modelo. Reformula (ej.: 'top 5 en AUTOESTIMA', 'promedio de IE por PARALELO', 'reporte de Apellido Nombre').",
        lists:[],
        tables:[]
      });
    }

    return res.json({
      ok: parsed.ok !== false,
      general: parsed.general || "",
      lists: Array.isArray(parsed.lists) ? parsed.lists : [],
      tables: Array.isArray(parsed.tables) ? parsed.tables : []
    });

  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ================== START ================== */
app.listen(PORT, () => {
  console.log(`API ready on :${PORT}`);
});
