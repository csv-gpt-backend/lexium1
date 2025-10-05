// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ===== Paths & Config =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const STORAGE_DIR = process.env.STORAGE_DIR || "/app/storage";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lexium123";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

await fs.mkdir(STORAGE_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "2mb" }));

// no-cache (stateless)
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// ===== CORS robusto (soporta https://*.vercel.app) =====
function originMatches(origin, pattern) {
  if (pattern === "*") return true;
  // convierte patrón con * a regex
  const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp("^" + esc(pattern).replace(/\\\*/g, ".*") + "$");
  return rx.test(origin);
}
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // cURL, Postman
      const ok = CORS_ORIGINS.some(pat => originMatches(origin, pat));
      cb(null, ok);
    },
  })
);

// ===== Helpers =====
const upload = multer({ storage: multer.memoryStorage() });

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ").trim();
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

// ===== CSV loader (auto ; o ,) =====
async function loadCSV(filename) {
  const full = path.join(STORAGE_DIR, filename);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw.replace(/\r/g,"").split("\n").filter(l => l.trim().length).map(l => l.replace(/\uFEFF/g,""));
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

  // castea columnas numéricas si aplica
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

// ===== TXT =====
async function readText(name) {
  const p = path.join(STORAGE_DIR, name);
  try { return await fs.readFile(p, "utf8"); }
  catch { return ""; }
}

// ===== Nombre tolerante =====
function tokenizeName(s) { return norm(s).split(/\s+/).filter(Boolean); }
function findBestStudent(rows, query) {
  const qn = norm(query);
  const exact = rows.find(r => norm(r.NOMBRE) === qn);
  if (exact) return { student: exact, suggestions: [] };
  const qTok = tokenizeName(qn);
  const scored = rows.map(r => {
    const nTok = tokenizeName(r.NOMBRE);
    const hits = qTok.reduce((acc, qt) => acc + (nTok.includes(qt) ? 1 : 0), 0);
    return { r, hits };
  }).filter(x => x.hits > 0);
  scored.sort((a,b)=> b.hits - a.hits || norm(a.r.NOMBRE).length - norm(b.r.NOMBRE).length);
  if (scored.length && scored[0].hits >= Math.min(qTok.length, 2)) {
    return { student: scored[0].r, suggestions: scored.slice(1,6).map(x=>x.r.NOMBRE) };
  }
  return { student: null, suggestions: scored.slice(0,10).map(x=>x.r.NOMBRE) };
}

// ===== Admin guard =====
function isAdmin(req){ return req.headers["x-admin-token"] === ADMIN_TOKEN; }
function requireAdmin(req, res, next){
  if (!ADMIN_TOKEN) return res.status(500).json({ ok:false, error:"admin_token_not_set" });
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

// ===== API =====
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

// CSV debug
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
    if (!q) return res.json({ ok:true, count: rows.length, names: rows.map(r=>r.NOMBRE).slice(0,200) });
    const qTok = tokenizeName(q);
    const names = rows
      .map(r=>r.NOMBRE)
      .map(n=>({n, score: tokenizeName(n).filter(t=>qTok.includes(t)).length}))
      .filter(x=>x.score>0)
      .sort((a,b)=> b.score - a.score || norm(a.n).length - norm(b.n).length)
      .map(x=>x.n);
    res.json({ ok:true, count: names.length, names: names.slice(0,100) });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// ===== /api/answer: consultas generales =====
// ===== /api/answer: consultas generales (sin exigir "según decimo.csv") =====
app.get("/api/answer", async (req, res) => {
  try{
    const q = String(req.query.q||"").trim();
    const nq = norm(q);

    const { rows, columns } = await loadCSV("decimo.csv");
    if (!rows.length) {
      return res.json({ ok:true, general:"No hay filas en decimo.csv.", lists:[], tables:[] });
    }

    // utilidades
    const colByNorm = {}; columns.forEach(h => colByNorm[norm(h)] = h);
    const has = (...tokens) => tokens.some(t => nq.includes(norm(t)));

    // Detectar métrica mencionada (si el usuario la nombra)
    let measure = columns.find(h => nq.includes(norm(h)));
    // Si no la nombra, intenta una razonable por defecto
    if (!measure) {
      measure = colByNorm[norm("PROMEDIO DE INTELIGENCIA EMOCIONAL")]
             || colByNorm[norm("AUTOESTIMA")]
             || columns.find(h => Number.isFinite(toNum(rows[0]?.[h])))
             || columns[0];
    }

    const nameKey = colByNorm[norm("NOMBRE")] || "NOMBRE";
    const parKey  = colByNorm[norm("PARALELO")] || "PARALELO";
    const cursoKey= colByNorm[norm("CURSO")]   || "CURSO";

    // ========== 1) "muestra N filas" ==========
    {
      const m = nq.match(/muestra\s+(\d+)\s+filas/);
      if (m) {
        const n = Math.max(1, Math.min(50, parseInt(m[1],10)));
        const subsetCols = [nameKey, cursoKey, parKey, measure].filter(Boolean);
        const sample = rows.slice(0,n).map(r => subsetCols.map(c=>r[c]));
        return res.json({
          ok:true,
          general:`Primeras ${n} filas.`,
          tables:[{title:"Muestra", columns:subsetCols, rows:sample}],
          lists:[]
        });
      }
    }

    // ========== 2) "promedio de X por PARALELO|CURSO|Global" ==========
    if (has("promedio")) {
      // ¿por qué agrupamos?
      let groupKey = null;
      if (has("por paralelo")) groupKey = parKey;
      if (has("por curso"))    groupKey = cursoKey;

      // Global
      if (has("global") || (!groupKey && !has("por"))) {
        const avg = mean(rows.map(r => r[measure]));
        return res.json({
          ok:true,
          general:`Promedio global de ${measure}.`,
          tables:[{title:"Global", columns:["Métrica","Promedio"], rows:[[measure, isNaN(avg)?"—":avg]]}],
          lists:[]
        });
      }

      // Agrupado
      if (groupKey) {
        const groups = by(rows, groupKey);
        const trows = [];
        for (const [gkey, arr] of groups) {
          trows.push([gkey, isNaN(mean(arr.map(r=>r[measure])))?"—":mean(arr.map(r=>r[measure]))]);
        }
        trows.sort((a,b)=> String(a[0]).localeCompare(String(b[0])));
        return res.json({
          ok:true,
          general:`Promedio de ${measure} por ${groupKey}.`,
          tables:[{title:`${groupKey}`, columns:[groupKey,"Promedio"], rows:trows}],
          lists:[]
        });
      }
      // Si dijo "promedio" pero no especificó grupo, ya devolvimos global arriba.
    }

    // ========== 3) "top N ... más alta / más baja" ==========
    if (nq.includes("top")) {
      const mm = nq.match(/top\s+(\d+)/); 
      const k = mm ? Math.max(1, Math.min(50, parseInt(mm[1],10))) : 5;
      const desc = (has("más alta","mas alta","mayor","maximo","máximo"));
      const asc  = (has("más baja","mas baja","menor","minimo","mínimo"));

      const data = rows
        .map(r => [r[nameKey], r[parKey], toNum(r[measure])])
        .filter(x => Number.isFinite(x[2]));

      data.sort((a,b)=> desc ? (b[2]-a[2]) : asc ? (a[2]-b[2]) : (b[2]-a[2]));

      return res.json({
        ok:true,
        general:`Top ${k} por ${measure} ${desc?"(más alta)":asc?"(más baja)":""}.`,
        tables:[{title:"Top", columns:[nameKey, parKey, measure], rows:data.slice(0,k)}],
        lists:[]
      });
    }

    // ========== 4) TXT: explica … según archivo ==========
    if (has("segun","según") && (has("emocionales txt") || has("evaluacion txt") || has("ubicacion txt"))) {
      let fname = "emocionales.txt";
      if (has("evaluacion txt")) fname = "evaluacion.txt";
      if (has("ubicacion txt"))  fname = "ubicacion.txt";
      const txt = await readText(fname);
      if (!txt) return res.json({ ok:true, general:`No encontré ${fname} en storage.`, lists:[], tables:[] });
      return res.json({ ok:true, general: txt.slice(0,1200) + (txt.length>1200 ? " …" : ""), lists:[], tables:[] });
    }

    // ========== Fallback mejorado ==========
    return res.json({
      ok:true,
      general:"No entendí del todo. Ejemplos: “reporte completo de Castillo D Julia”, “top 5 estudiantes con AUTOESTIMA más baja”, “promedio de ASERTIVIDAD por PARALELO”, “muestra 5 filas”.",
      lists:[],
      tables:[]
    });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});


// ===== /api/report: perfil completo de un estudiante =====
app.get("/api/report", async (req, res) => {
  try{
    const q = String(req.query.q||"");
    const nq = norm(q);
    let person = q;
    const m = nq.match(/reporte\s+completo\s+de\s+(.+)/);
    if (m) person = q.slice(m.index + m[0].length).trim();

    const { rows, columns } = await loadCSV("decimo.csv");
    if (!rows.length) return res.json({ ok:true, general:"No hay datos en decimo.csv.", lists:[], tables:[] });

    const { student, suggestions } = findBestStudent(rows, person);
    if (!student) {
      return res.json({
        ok:true,
        general:`No encontré a '${person}' en decimo.csv.`,
        lists: suggestions.length ? [{ title:"¿Quizás te refieres a…?", items:suggestions }] : [],
        tables:[]
      });
    }

    const key = (name) => columns.find(h => norm(h) === norm(name)) || name;
    const K = {
      NOMBRE: key("NOMBRE"),
      CURSO: key("CURSO"),
      PARALELO: key("PARALELO"),
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

    const nombre = student[K.NOMBRE];
    const curso = student[K.CURSO];
    const paralelo = student[K.PARALELO];
    const ie = toNum(student[K.IE]);

    const pares = HABS
      .filter(h => student[h] !== undefined && student[h] !== "")
      .map(h => [h, toNum(student[h])])
      .filter(([, v]) => Number.isFinite(v));

    const fortalezas = pares.filter(([, v]) => v >= 71).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([h,v])=>`${h}: ${v} (${bucket(v)})`);
    const mejoras    = pares.filter(([, v]) => v <= 40).sort((a,b)=>a[1]-b[1]).slice(0,5).map(([h,v])=>`${h}: ${v} (${bucket(v)})`);

    const perfilRows = pares.sort((a,b)=>b[1]-a[1]).map(([h,v])=>[h, v, bucket(v)]);
    const domRows = DOMS.map(d => [d, toNum(student[d]), bucket(toNum(student[d]))]).filter(r=>Number.isFinite(r[1]));

    const general = `Informe socioemocional de ${nombre} (CURSO ${curso}, PARALELO ${paralelo}). IE Global: ${Number.isFinite(ie)?ie:"—"} (${bucket(ie)}).`;

    const lists = [];
    if (fortalezas.length) lists.push({ title:"Fortalezas destacadas", items:fortalezas });
    if (mejoras.length)    lists.push({ title:"Áreas de mejora prioritarias", items:mejoras });

    return res.json({
      ok:true,
      general,
      tables: [
        { title:"Perfil por Habilidad", columns:["Habilidad","Puntaje","Rango"], rows:perfilRows },
        { title:"Dominios", columns:["Dominio","Puntaje","Rango"], rows:domRows },
      ],
      lists
    });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`API ready on :${PORT}`);
});
