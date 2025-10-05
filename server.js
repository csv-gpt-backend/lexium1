// server.js — Lexium API con /api/report
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import formidable from "formidable";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// -------- Config --------
const PORT          = process.env.PORT || 8080;
const STORAGE_DIR   = process.env.STORAGE_DIR || "/app/storage";
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || "";
const CORS_ORIGINS  = (process.env.CORS_ORIGINS || "*")
  .split(",").map(s=>s.trim()).filter(Boolean);
const OPENAI_MODEL  = process.env.OPENAI_MODEL || "gpt-5.1";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// asegurar storage
await fs.mkdir(STORAGE_DIR, { recursive: true });

// -------- CORS --------
function originOk(origin) {
  if (!origin) return true; // curl o mismo origen
  if (CORS_ORIGINS.includes("*")) return true;
  return CORS_ORIGINS.some(pat => {
    if (pat.endsWith("*")) return origin.startsWith(pat.slice(0,-1));
    return origin === pat;
  });
}
const app = express();
app.use((req,res,next)=>{
  cors({
    origin: (origin, cb) => cb(originOk(origin) ? null : new Error("CORS"), true),
    credentials: false
  })(req,res,next);
});
app.use(express.json());

// -------- Utils comunes --------
const requireAdmin = (req,res,next) => {
  if (!ADMIN_TOKEN) return res.status(500).json({ ok:false, error:"admin_token_not_set" });
  const tok = req.header("x-admin-token") || "";
  if (tok !== ADMIN_TOKEN) return res.status(403).json({ ok:false, error:"forbidden" });
  next();
};
const safeBase = name => path.basename(name||"").replace(/\.\.+/g,".");
const fpath   = name => path.join(STORAGE_DIR, safeBase(name));

// split de CSV con comillas
function splitCSVLine(line, delimiter) {
  const out=[]; let cur=""; let q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"') {
      if (q && line[i+1]==='"') { cur+='"'; i++; }
      else q=!q;
    } else if (ch === delimiter && !q) { out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out;
}
function detectDelimiterFromHeader(s) {
  const a = (s.match(/;/g)||[]).length;
  const b = (s.match(/,/g)||[]).length;
  return a >= b ? ";" : ",";
}
function normalizeHeader(h) {
  return String(h||"").trim().toUpperCase();
}
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v)? v : NaN;
  if (typeof v !== "string") return NaN;
  let t = v.trim().replace(/[^\d,.\-+]/g,"");
  if (t.includes(",") && !t.includes(".")) t = t.replace(",",".");
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
function removeDiacritics(s){
  return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
}
function normName(s){
  return removeDiacritics(s).toUpperCase().replace(/[^A-Z0-9\s]/g,"").replace(/\s+/g," ").trim();
}

// Lee CSV completo con tipado numérico (si ≥60% numérico)
function typeOfColumn(values) {
  let num=0, tot=0;
  for (const v of values) {
    if (String(v).trim()==="") continue;
    tot++; if (Number.isFinite(toNumber(v))) num++;
  }
  if (tot>0 && (num/tot)>=0.6) return "number";
  return "string";
}
async function loadCSV(name) {
  const raw = await fs.readFile(fpath(name), "utf8");
  const text = raw.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  const lines = text.split("\n").filter(l=>l.trim().length);
  if (!lines.length) return { headers:[], rows:[], types:{} };

  const delimiter = detectDelimiterFromHeader(lines[0]);
  const headersRaw = splitCSVLine(lines[0], delimiter).map(s=>s.trim());
  const headers    = headersRaw.map(normalizeHeader);

  const rowsRaw = lines.slice(1).map(line=>{
    const cells = splitCSVLine(line, delimiter);
    const o={};
    headers.forEach((h,i)=>{ o[h] = (cells[i] ?? "").trim(); });
    return o;
  });

  // tipado
  const types = {};
  headers.forEach(h=>{
    const sample = rowsRaw.slice(0,200).map(r=>r[h]);
    types[h] = typeOfColumn(sample);
  });
  const rows = rowsRaw.map(r=>{
    const o={};
    headers.forEach(h=>{
      o[h] = (types[h]==="number") ? toNumber(r[h]) : r[h];
    });
    return o;
  });

  return { headersRaw, headers, types, rows, delimiter };
}

// Fuzzy find estudiante por NOMBRE (exacto, incluye, tokens)
function findStudentRow(rows, name, col="NOMBRE") {
  const COL = normalizeHeader(col);
  const qn  = normName(name);
  let best = null, bestScore = -1;

  for (const r of rows) {
    const rn = normName(r[COL]);
    if (!rn) continue;
    if (rn === qn) return r; // exacto
    // score simple por tokens
    const qt = new Set(qn.split(" "));
    const rt = new Set(rn.split(" "));
    let hit = 0;
    qt.forEach(t => { if (rt.has(t)) hit++; });
    const score = hit / Math.max(qt.size, rt.size);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  // umbral moderado
  return bestScore >= 0.5 ? best : null;
}

// Percentil empírico midrank
function percentileOf(val, arr) {
  const xs = arr.filter(Number.isFinite).slice().sort((a,b)=>a-b);
  const n = xs.length;
  if (n===0) return null;
  let lt=0, eq=0;
  for (const x of xs) {
    if (x < val) lt++;
    else if (x === val) eq++;
    else break;
  }
  if (eq===0) {
    // buscar eq exactos (segunda pasada)
    for (let i=lt;i<n;i++){
      if (xs[i]===val) eq++;
      else break;
    }
  }
  const p = ((lt + 0.5*eq) / n) * 100;
  return Math.max(1, Math.min(100, Math.round(p)));
}
function rangoPorPercentil(p) {
  if (p == null) return "SIN DATOS";
  if (p <= 40) return "BAJO";
  if (p <= 70) return "PROMEDIO";
  return "ALTO";
}

// Construye cohortes
function cohortes(rows, alumno, colPar="PARALELO", colCur="CURSO") {
  const PAR = normalizeHeader(colPar);
  const CUR = normalizeHeader(colCur);
  const par = String(alumno[PAR] ?? "").trim();
  const cur = String(alumno[CUR] ?? "").trim();

  const enPar = rows.filter(r => String(r[PAR] ?? "").trim() === par);
  const enCur = rows.filter(r => String(r[CUR] ?? "").trim() === cur);
  const global = rows;
  return { par, cur, enPar, enCur, global };
}

// Selección de columnas (dominios ya calculados)
function columnasDominios(headers) {
  // coincide con tus nombres (ajústalos si cambian)
  const wanted = [
    "PROMEDIO DE HABILIDADES INTRAPERSONALES",
    "PROMEDIO DE HABILIDADES INTERPERSONALES",
    "PROMEDIO DE HABILIDADES PARA LA VIDA",
    "PROMEDIO DE INTELIGENCIA EMOCIONAL"
  ];
  return wanted.filter(w => headers.includes(w));
}
function columnasBasicas(headers) {
  return ["NOMBRE","EDAD","CURSO","PARALELO"].filter(h => headers.includes(h));
}
function columnasHabilidades(headers) {
  // todas las numéricas excepto básicas y dominios
  const basic = new Set(columnasBasicas(headers));
  const doms  = new Set(columnasDominios(headers));
  const out=[];
  for (const h of headers) {
    if (basic.has(h) || doms.has(h)) continue;
    out.push(h);
  }
  return out;
}

// -------- Rutas auxiliares ya existentes --------
app.get("/api/ping", (req,res)=>{
  res.json({ ok:true, pong:"🏓", region: process.env.FLY_REGION || null });
});
app.get("/api/files", async (req,res)=>{
  try {
    const files = (await fs.readdir(STORAGE_DIR)).sort();
    res.json({ ok:true, files });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});
app.post("/api/files/upload", requireAdmin, (req,res)=>{
  const form = formidable({
    multiples: true,
    uploadDir: STORAGE_DIR,
    keepExtensions: true,
    filename: (name, ext, part) => safeBase(part.originalFilename || part.newFilename || name+ext)
  });
  form.parse(req, async (err, fields, files)=>{
    try {
      if (err) return res.status(400).json({ ok:false, error:String(err.message||err) });
      const picked = files.files;
      const arr = Array.isArray(picked) ? picked : (picked?[picked]:[]);
      const saved=[];
      for (const f of arr) {
        if (!f) continue;
        const tmp = f.filepath || f.path;
        const fin = fpath(f.originalFilename || f.newFilename || f.name);
        try { await fs.rename(tmp, fin); }
        catch { await fs.copyFile(tmp, fin); await fs.unlink(tmp).catch(()=>{}); }
        saved.push(path.basename(fin));
      }
      res.json({ ok:true, files:saved });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message||e) });
    }
  });
});
app.get("/api/debug/csv", requireAdmin, async (req,res)=>{
  try {
    const name = safeBase(req.query.name || "decimo.csv");
    const { headers, rows, delimiter } = await loadCSV(name);
    res.json({ ok:true, delimiter, columns: headers, count: rows.length, sample: rows.slice(0,5) });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// -------- NUEVO: /api/report --------
// q: texto natural, p.ej. "reporte completo de Castillo D Julia"
app.get("/api/report", async (req,res)=>{
  const q = String(req.query.q||"").trim();
  try {
    // 1) carga CSV principal
    const file = "decimo.csv";
    const { headers, rows } = await loadCSV(file);
    if (!rows.length) {
      return res.json({ ok:false, error:`no_rows_in_${file}` });
    }

    // 2) extrae nombre buscado (si viene “de X” lo tomamos; si no, usamos todo)
    // Soportamos formas: "reporte ... de <Nombre>", "para <Nombre>", "de la estudiante <Nombre>"
    let nombre = null;
    const m = q.match(/\b(?:de|para)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ\s\.]+)$/);
    if (m) nombre = m[1].trim();
    // fallback: si no viene, intentaremos “CASTILLO D JULIA” como demo
    if (!nombre) nombre = "CASTILLO D JULIA";

    // 3) localizar alumno
    const colsBase = columnasBasicas(headers);
    const COL_N    = colsBase.includes("NOMBRE") ? "NOMBRE" : headers.find(h=>/NOMBRE/i.test(h)) || null;
    if (!COL_N) return res.json({ ok:false, error:"no_name_column" });

    const alumno = findStudentRow(rows, nombre, COL_N);
    if (!alumno) {
      return res.json({ ok:true, general:`No encontré a '${nombre}' en ${file}.`, lists:[], tables:[] });
    }

    // 4) cohortes (PARALELO, CURSO, Global)
    const { par, cur, enPar, enCur, global } = cohortes(rows, alumno, "PARALELO","CURSO");

    // 5) columnas (dominios + habilidades)
    const colDom = columnasDominios(headers);
    const colHab = columnasHabilidades(headers);

    // 6) percentiles y rangos para cada habilidad
    function percentilesPara(col, rangoSobre) {
      const val = alumno[col];
      const arrPar = enPar.map(r=>r[col]);
      const arrCur = enCur.map(r=>r[col]);
      const arrGlo = global.map(r=>r[col]);
      const pPar = percentileOf(val, arrPar);
      const pCur = percentileOf(val, arrCur);
      const pGlo = percentileOf(val, arrGlo);
      return {
        valor: Number.isFinite(val) ? val : null,
        p_paralelo: pPar, rango_paralelo: rangoPorPercentil(pPar),
        p_curso:    pCur, rango_curso:    rangoPorPercentil(pCur),
        p_global:   pGlo, rango_global:   rangoPorPercentil(pGlo)
      };
    }

    // 7) Tabla de puntajes por HABILIDAD (todas menos básicas y dominios)
    const tablaHabRows = colHab.map(h => {
      const r = percentilesPara(h);
      return [h, r.valor, r.p_paralelo, r.rango_paralelo, r.p_curso, r.rango_curso];
    });
    const tablaHab = {
      title: "Puntajes y percentiles por habilidad",
      columns: ["HABILIDAD","PUNTAJE","P% PARALELO","RANGO PARALELO","P% CURSO","RANGO CURSO"],
      rows: tablaHabRows
    };

    // 8) Tabla de DOMINIOS (ya promediados en CSV)
    const tablaDomRows = colDom.map(d => {
      const r = percentilesPara(d);
      return [d, r.valor, r.p_paralelo, r.rango_paralelo, r.p_curso, r.rango_curso];
    });
    const tablaDom = {
      title: "Dominios (promedios existentes)",
      columns: ["DOMINIO","PUNTAJE","P% PARALELO","RANGO PARALELO","P% CURSO","RANGO CURSO"],
      rows: tablaDomRows
    };

    // 9) Datos del estudiante
    const datosCols = ["NOMBRE","EDAD","CURSO","PARALELO"].filter(c => c in alumno);
    const datosVals = datosCols.map(c => alumno[c]);
    const tablaDatos = {
      title: "Datos del estudiante",
      columns: datosCols,
      rows: [datosVals]
    };

    // 10) Fortalezas / áreas (heurística local para darle pistas al LLM)
    const strengths = [];
    const needs = [];
    for (const [h,val,pPar] of tablaHab.rows.map(r => [r[0], r[1], r[2]])) {
      if (pPar == null) continue;
      if (pPar >= 71) strengths.push(`${h} (P% paralelo: ${pPar})`);
      if (pPar <= 40) needs.push(`${h} (P% paralelo: ${pPar})`);
    }
    // también dominios
    for (const [d,val,pPar] of tablaDom.rows.map(r => [r[0], r[1], r[2]])) {
      if (pPar == null) continue;
      if (pPar >= 71) strengths.push(`Dominio ${d} (P% paralelo: ${pPar})`);
      if (pPar <= 40) needs.push(`Dominio ${d} (P% paralelo: ${pPar})`);
    }

    // 11) TXT para narrativa (si existen)
    async function readIfExists(n){ try { return await fs.readFile(fpath(n), "utf8"); } catch { return ""; } }
    const txtEmo  = await readIfExists("emocionales.txt");
    const txtEval = await readIfExists("evaluaciones.txt");
    const txtUbic = await readIfExists("ubicacion.txt");
    const txtBundle = [
      txtEmo ? `--- emocionales.txt ---\n${txtEmo}` : "",
      txtEval? `--- evaluaciones.txt ---\n${txtEval}` : "",
      txtUbic? `--- ubicacion.txt ---\n${txtUbic}` : ""
    ].filter(Boolean).join("\n\n");
    const contextoTXT = txtBundle.slice(0, 12000); // límite prudente

    // 12) Resumen con GPT-5 (si hay API key)
    let resumen = `Informe orientativo (no clínico) para ${alumno["NOMBRE"]}.`;
    let listFort = strengths.slice(0,8);
    let listNeed = needs.slice(0,8);
    let listRec  = [];
    let listObs  = ["Este informe es de carácter educativo/orientativo y no constituye diagnóstico clínico."];

    const facts = {
      estudiante: Object.fromEntries(datosCols.map((c,i)=>[c,datosVals[i]])),
      paralelo: par, curso: cur,
      dominios: Object.fromEntries(colDom.map(d => [d, alumno[d]])),
      top_fortalezas_sugeridas: listFort,
      top_areas_mejora_sugeridas: listNeed
    };

    if (process.env.OPENAI_API_KEY) {
      try {
        const plan = await openai.responses.create({
          model: OPENAI_MODEL,
          response_format: { type: "json_object" },
          input: [
            { role:"system", content:
              "Eres un orientador educativo. Redacta en español un informe basado EXCLUSIVAMENTE en los datos y textos provistos. No inventes. Incluye advertencia de no-diagnóstico." },
            { role:"user", content:
`DATOS:
${JSON.stringify(facts,null,2)}

TABLAS (resumen):
- Habilidades (con percentiles por paralelo y curso, y rangos 1-40 bajo, 41-70 promedio, 71-100 alto)
- Dominios (igual)

TEXTOS (ficha técnica / institucional):
${contextoTXT}

TAREA:
Devuelve un JSON con:
{
  "resumen": "2-3 párrafos",
  "fortalezas": ["viñeta", ... 4-8 ítems],
  "areas_mejora": ["viñeta", ... 4-8 ítems],
  "recomendaciones": ["acción concreta, medible y respetuosa", ... 4-8 ítems],
  "observaciones": ["Incluye nota explícita de NO diagnóstico clínico."]
}
` }
          ]
        });
        const out = plan.output_text || (plan?.output?.[0]?.content?.[0]?.text ?? "{}");
        const j = JSON.parse(out);
        if (j.resumen)       resumen = j.resumen;
        if (Array.isArray(j.fortalezas))    listFort = j.fortalezas;
        if (Array.isArray(j.areas_mejora))  listNeed = j.areas_mejora;
        if (Array.isArray(j.recomendaciones)) listRec = j.recomendaciones;
        if (Array.isArray(j.observaciones)) listObs  = j.observaciones;
      } catch(e) {
        // fallback local
        listRec = [
          "Refuerzo positivo sistemático en contextos de aula.",
          "Actividades guiadas para fortalecer habilidades con rango bajo.",
          "Seguimiento quincenal con tutor/a para objetivos específicos.",
          "Comunicación breve con familia sobre avances y acuerdos."
        ];
      }
    } else {
      // sin API key: narrativa local mínima
      resumen += " (Nota: redacción automática limitada por ausencia de OPENAI_API_KEY).";
      listRec = [
        "Establecer metas semanales y revisar avances.",
        "Ofrecer andamiajes y feedback descriptivo.",
        "Incorporar prácticas de regulación emocional breves diarias.",
        "Coordinar con familia acciones de apoyo en casa."
      ];
    }

    // 13) Respuesta final
    return res.json({
      ok: true,
      general: resumen,
      lists: [
        { title: "Fortalezas", items: listFort },
        { title: "Áreas de mejora", items: listNeed },
        { title: "Recomendaciones", items: listRec },
        { title: "Observaciones", items: listObs }
      ],
      tables: [
        tablaDatos,
        tablaDom,
        tablaHab
      ]
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// -------- Start --------
app.listen(PORT, ()=> {
  console.log(`API ready on :${PORT}`);
});
