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
app.get("/api/answer", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ ok: false, error: "missing_q" });

  try {
    if (q.toLowerCase().includes(".csv")) {
      const ans = await answerCsv(q);
      return res.json(ans);
    } else if (q.toLowerCase().includes(".txt")) {
      const ans = await answerTxt(q);
      return res.json(ans);
    }
    // si no especifica archivo, responde básico
    return res.json({ ok: true, general: "Indica el archivo, por ejemplo: 'promedio de AUTOESTIMA por Paralelo según decimo.csv'." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
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
