// server.js (ESM)
// Node 18/20 compatible

import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { fileURLToPath } from "url";

// ====== Config básica ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const STORAGE_DIR = path.join(process.cwd(), "storage"); // en Fly => /app/storage
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lexium123";

// CORS: lista separada por comas o "*"
const RAW_ORIGINS = (process.env.CORS_ORIGINS || "").trim();
const ALLOW_WILDCARD_VERCEL = RAW_ORIGINS.includes("*.vercel.app");
const ALLOWED_ORIGINS = RAW_ORIGINS
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// asegúrate que exista la carpeta de almacenamiento
await fsp.mkdir(STORAGE_DIR, { recursive: true });

// ====== Helpers de CORS ======
function isAllowedOrigin(origin) {
  if (!origin) return true; // Hoppscotch / file://
  if (RAW_ORIGINS === "*" || ALLOWED_ORIGINS.includes(origin)) return true;
  if (ALLOW_WILDCARD_VERCEL && /\.vercel\.app$/.test(new URL(origin).hostname)) {
    return true;
  }
  return false;
}

const app = express();
app.use(express.json());

// CORS dinámico
app.use(
  cors({
    origin: (origin, cb) => {
      try {
        if (isAllowedOrigin(origin)) return cb(null, true);
        return cb(new Error("CORS blocked"));
      } catch {
        return cb(new Error("CORS error"));
      }
    },
    credentials: false,
  })
);

// ====== Multer (subida en memoria; luego guardamos a disco) ======
const upload = multer({ storage: multer.memoryStorage() });
// === Helpers numéricos y CSV (nuevo) ===
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Carpeta de archivos (ajusta si tu servidor usa otra)
const STORAGE_DIR = process.env.STORAGE_DIR || "/app/storage";

// Convierte string -> número seguro (acepta coma decimal y limpia símbolos)
function toNum(x) {
  if (typeof x === "number") return Number.isFinite(x) ? x : NaN;
  if (typeof x === "string") {
    const y = x.trim()
      .replace(",", ".")            // coma decimal → punto
      .replace(/[^\d.+\-eE]/g, ""); // deja dígitos y signo/decimal/exponente
    if (!y || y === "." || y === "+" || y === "-") return NaN;
    const n = Number(y);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

// Calcula promedio de colValor agrupado por colGrupo en 'rows' (array de objetos)
function promedioPorGrupo(rows, colValor, colGrupo) {
  const grupos = new Map(); // clave → array de números
  for (const r of rows) {
    const key = String(r[colGrupo] ?? "").trim();
    const val = toNum(r[colValor]);
    if (!key) continue;
    if (!Number.isFinite(val)) continue; // ignora no numéricos
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(val);
  }
  const salida = [];
  for (const [k, arr] of grupos.entries()) {
    if (!arr.length) continue;
    const prom = arr.reduce((a,b)=>a+b,0) / arr.length;
    salida.push([k, Number(prom.toFixed(1))]); // 1 decimal
  }
  // orden opcional por clave
  salida.sort((a,b)=> String(a[0]).localeCompare(String(b[0])));
  return salida;
}

// Lector CSV ligero (autodetecta ; o ,)
async function readCsvLight(name) {
  const full = path.join(STORAGE_DIR, name);
  const raw = await fs.readFile(full, "utf8");
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter(l => l.trim() !== "");
  if (!lines.length) return { columns: [], rows: [], delimiter: "," };

  const first = lines[0];
  const scoreSemicolon = first.split(";").length;
  const scoreComma     = first.split(",").length;
  const sep = scoreSemicolon > scoreComma ? ";" : ",";

  const headers = first.split(sep).map(s => s.trim());
  const rows = lines.slice(1).map(line => {
    const cells = line.split(sep);
    const obj   = {};
    headers.forEach((h,i) => { obj[h] = (cells[i] ?? "").trim(); });
    return obj;
  });
  return { columns: headers, rows, delimiter: sep };
}
// === FIN Helpers (nuevo) ===

// ====== Utils de archivos ======
function sanitizeName(name) {
  return String(name || "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .trim();
}
async function listFiles() {
  const all = await fsp.readdir(STORAGE_DIR, { withFileTypes: true });
  return all
    .filter(d => d.isFile())
    .map(d => d.name)
    .sort();
}
async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ====== CSV: parser simple con autodetección de delimitador ======
function detectDelimiter(raw) {
  const head = raw.slice(0, 2000);
  const semis = (head.match(/;/g) || []).length;
  const commas = (head.match(/,/g) || []).length;
  return semis > commas ? ";" : ",";
}

function parseCsvLine(line, delim) {
  // Parser básico con comillas: "campo;con;delim"
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'; // escapado ""
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvSimple(raw) {
  const delim = detectDelimiter(raw);
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  // encabezados (quita BOM)
  const first = lines[0].replace(/^\uFEFF/, "");
  const headers = parseCsvLine(first, delim).map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], delim);
    if (!cells.length) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (cells[j] ?? "").trim();
    }
    rows.push(obj);
  }
  return { headers, rows, delim };
}

// normaliza: mayúsculas, sin tildes, sin dobles espacios
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function numeric(v) {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ====== Endpoints básicos ======
app.get("/", (_req, res) => {
  res.type("text/plain").send("Lexium API OK");
});

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, pong: "🏓", region: process.env.FLY_REGION || null });
});

// ====== Gestión de archivos ======
app.get("/api/files", async (req, res) => {
  try {
    // si quieres proteger también el GET, descomenta:
    // if (ADMIN_TOKEN && req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    //   return res.status(403).json({ ok:false, error:"forbidden" });
    // }
    const names = await listFiles();
    res.json({ ok: true, files: names });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/files/upload", upload.array("files"), async (req, res) => {
  try {
    if (ADMIN_TOKEN && req.headers["x-admin-token"] !== ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: "no_files" });
    }
    const saved = [];
    for (const f of files) {
      const clean = sanitizeName(f.originalname);
      const dest = path.join(STORAGE_DIR, clean);
      await fsp.writeFile(dest, f.buffer);
      saved.push(clean);
    }
    res.json({ ok: true, files: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.delete("/api/files", async (req, res) => {
  try {
    if (ADMIN_TOKEN && req.headers["x-admin-token"] !== ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const name = sanitizeName(req.query.name);
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });
    const p = path.join(STORAGE_DIR, name);
    if (!(await fileExists(p))) return res.status(404).json({ ok: false, error: "not_found" });
    await fsp.unlink(p);
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== DEBUG: inspeccionar CSV (protegido) ======
app.get("/api/debug/csv", async (req, res) => {
  try {
    if (ADMIN_TOKEN && req.headers["x-admin-token"] !== ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const name = sanitizeName(req.query.name);
    if (!name) return res.status(400).json({ ok: false, error: "name query required" });
    const p = path.join(STORAGE_DIR, name);
    if (!(await fileExists(p))) return res.status(404).json({ ok: false, error: "not_found" });

    const raw = await fsp.readFile(p, "utf8");
    const { headers, rows, delim } = parseCsvSimple(raw);
    res.json({
      ok: true,
      delimiter: delim,
      columns: headers,
      sample: rows.slice(0, 5),
      count: rows.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== /api/answer ======
// ---- /api/answer ----
// Responde tanto TXT ("explica ... según evaluacion.txt")
// como CSV ("promedio de AUTOESTIMA por PARALELO según decimo.csv")
app.get("/api/answer", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    // --- Caso CSV: "promedio de X por Y según archivo.csv"
    const rxCsv = /promedio\s+de\s+(.+?)\s+por\s+(.+?)\s+seg[uú]n\s+(.+?\.csv)/i;
    const mmCsv = q.match(rxCsv);
    if (mmCsv) {
      const colValor = mmCsv[1].trim();
      const colGrupo = mmCsv[2].trim();
      const fileCsv  = mmCsv[3].trim();

      // lee CSV (autodetecta ; o ,)
      const { columns, rows, delimiter } = await readCsvLight(fileCsv);

      if (!rows.length) {
        return res.json({
          ok: true,
          general: `No se encontraron filas en ${fileCsv}.`,
          lists: [],
          tables: []
        });
      }

      // intenta localizar columnas ignorando mayúsculas/minúsculas y espacios
      const norm = s => String(s).trim().toUpperCase();
      const colValorReal = columns.find(c => norm(c) === norm(colValor)) || colValor;
      const colGrupoReal = columns.find(c => norm(c) === norm(colGrupo)) || colGrupo;

      const outRows = promedioPorGrupo(rows, colValorReal, colGrupoReal);

      if (!outRows.length) {
        return res.json({
          ok: true,
          general: `No se encontraron valores numéricos para calcular el promedio de '${colValorReal}' por '${colGrupoReal}' en ${fileCsv}.`,
          lists: [],
          tables: []
        });
      }

      return res.json({
        ok: true,
        general: `Promedio de ${colValorReal} por ${colGrupoReal} usando '${fileCsv}' (delimitador '${delimiter}').`,
        lists: [],
        tables: [{
          title: `Promedio de ${colValorReal} por ${colGrupoReal}`,
          columns: [colGrupoReal, `Promedio ${colValorReal}`],
          rows: outRows
        }]
      });
    }

    // --- Caso TXT: "explica ... según archivo.txt"
    const rxTxt = /(explica|resumen|resume|defin[eí]ne)\b.*seg[uú]n\s+(.+?\.txt)/i;
    const mmTxt = q.match(rxTxt);
    if (mmTxt) {
      const fileTxt = mmTxt[2].trim();
      const full    = path.join(STORAGE_DIR, fileTxt);
      const text    = await fs.readFile(full, "utf8");

      // mini "resumen": primeras 6 líneas no vacías
      const lines = text.replace(/\r\n/g,"\n").split("\n").map(s=>s.trim()).filter(Boolean);
      const pick  = lines.slice(0, 6);

      return res.json({
        ok: true,
        general: pick.join(" "),
        lists: pick.length ? [{
          title: `Puntos clave según ${fileTxt}`,
          items: pick
        }] : [],
        tables: []
      });
    }

    // fallback si la pregunta no encaja con patrones conocidos
    return res.json({
      ok: true,
      general: "Pregunta recibida, pero no identifiqué un patrón soportado. Intenta por ejemplo:\n- promedio de AUTOESTIMA por PARALELO según decimo.csv\n- explica la asertividad según evaluacion.txt",
      lists: [],
      tables: []
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
});

// ====== Lógica: CSV ======
async function answerCsv(q) {
  // extrae nombre del csv (…según X.csv / segun X.csv)
  const m = q.match(/seg[uú]n\s+([A-Za-z0-9_.-]+\.csv)/i) || q.match(/([A-Za-z0-9_.-]+\.csv)/i);
  if (!m) return { ok: false, error: "no_csv_name_in_query" };

  const csvName = sanitizeName(m[1]);
  const csvPath = path.join(STORAGE_DIR, csvName);
  if (!(await fileExists(csvPath))) {
    return { ok: false, error: `csv_not_found: ${csvName}` };
  }

  const raw = await fsp.readFile(csvPath, "utf8");
  const { headers, rows } = parseCsvSimple(raw);
  if (!rows.length) {
    return { ok: true, general: "No se encontraron filas en el CSV.", tables: [], lists: [] };
  }

  // identifica columnas
  const H = headers;
  const Hn = H.map(norm);

  // heurísticas a partir del texto de la pregunta
  const nq = norm(q);

  // métrica: intenta detectar una palabra que coincida con un encabezado
  let metricHeader = null;
  for (const h of H) {
    if (nq.includes(norm(h))) {
      metricHeader = h;
      break;
    }
  }
  // fallback comunes: AUTOESTIMA, ASERTIVIDAD, PROMEDIO...
  if (!metricHeader) {
    const prefs = ["AUTOESTIMA", "ASERTIVIDAD", "PROMEDIO"];
    for (const pref of prefs) {
      const idx = Hn.indexOf(pref);
      if (idx >= 0) { metricHeader = H[idx]; break; }
    }
  }

  // dimensión / agrupación
  let groupHeader = null;
  const groupPrefs = [
    { key: "PARALELO", aliases: ["PARALELO"] },
    { key: "CURSO", aliases: ["CURSO"] },
    { key: "SECCION", aliases: ["SECCION", "SECCIÓN"] },
  ];

  for (const gp of groupPrefs) {
    if (nq.includes(gp.key) || gp.aliases.some(a => nq.includes(norm(a)))) {
      const idx = Hn.indexOf(gp.key);
      if (idx >= 0) { groupHeader = H[idx]; break; }
    }
  }
  // fallback si no especifica: intenta PARALLELO si existe
  if (!groupHeader) {
    const idx = Hn.indexOf("PARALELO");
    if (idx >= 0) groupHeader = H[idx];
  }

  if (!metricHeader || !groupHeader) {
    return {
      ok: true,
      general:
        "No se puede proporcionar información porque no se detectaron las columnas necesarias (métrica y/o agrupación). " +
        "Verifica que en el CSV existan, por ejemplo, 'AUTOESTIMA' y 'PARALELO'.",
      tables: [],
      lists: []
    };
  }

  // agrupa y calcula promedio
  const groups = new Map(); // group -> { sum, count }
  for (const r of rows) {
    const g = (r[groupHeader] ?? "").trim();
    const v = numeric(r[metricHeader]);
    if (!g || v == null) continue;
    const acc = groups.get(g) || { sum: 0, count: 0 };
    acc.sum += v;
    acc.count += 1;
    groups.set(g, acc);
  }

  const result = Array.from(groups.entries())
    .map(([g, { sum, count }]) => [g, +(sum / count).toFixed(1)])
    .sort((a, b) => (a[0] > b[0] ? 1 : -1));

  if (!result.length) {
    return {
      ok: true,
      general: "No se encontraron valores numéricos para calcular el promedio con las columnas detectadas.",
      tables: [],
      lists: []
    };
  }

  return {
    ok: true,
    general: `Promedio de ${metricHeader} por ${groupHeader} según ${csvName}.`,
    tables: [
      {
        title: `Promedio de ${metricHeader} por ${groupHeader}`,
        columns: [groupHeader, `Promedio ${metricHeader}`],
        rows: result.map(([g, avg]) => [g, avg])
      }
    ],
    lists: []
  };
}

// ====== Lógica: TXT (resumen simple local) ======
async function answerTxt(q) {
  // extrae nombre del txt
  const m = q.match(/([A-Za-z0-9_.-]+\.txt)/i);
  if (!m) return { ok: false, error: "no_txt_name_in_query" };
  const txtName = sanitizeName(m[1]);
  const txtPath = path.join(STORAGE_DIR, txtName);
  if (!(await fileExists(txtPath))) return { ok: false, error: `txt_not_found: ${txtName}` };

  const content = await fsp.readFile(txtPath, "utf8");
  // resumen local muy simple (las primeras frases/párrafos)
  const snippet = content
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");

  const general =
    snippet.length > 0
      ? `Resumen de ${txtName}: ${snippet.slice(0, 900)}${snippet.length > 900 ? "…" : ""}`
      : `No se pudo extraer contenido de ${txtName}.`;

  return { ok: true, general, lists: [], tables: [] };
}

// ====== Start ======
app.listen(PORT, () => {
  console.log(`Lexium API listening on http://0.0.0.0:${PORT}`);
});
