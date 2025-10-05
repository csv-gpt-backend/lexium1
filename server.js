// @ts-check
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";

// ===== Paths / env =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE = process.env.STORAGE_DIR || "/app/storage";
fs.mkdirSync(STORAGE, { recursive: true });

const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lexium123";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cambia si quieres

// ===== CORS =====
const ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || ORIGINS.includes("*") || ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
};

// ===== Express =====
const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ===== Upload (multer) =====
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STORAGE),
  filename: (_req, file, cb) => cb(null, file.originalname), // reemplaza si coincide
});
const upload = multer({ storage });

// ===== Utils =====
const adminOnly = (req, res, next) => {
  const tok = req.headers["x-admin-token"];
  if (!tok || tok !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
};

const readTextSafe = async (file) => {
  try {
    const p = path.join(STORAGE, path.basename(file));
    return await fs.promises.readFile(p, "utf8");
  } catch {
    return null;
  }
};

const listFiles = async () => {
  const entries = await fs.promises.readdir(STORAGE, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
};

// Detecta nombres de archivo en una pregunta
const pickFilenames = (q) => {
  const re = /([A-Za-z0-9._\- áéíóúñÁÉÍÓÚÑ]+?\.(?:txt|csv))/gi;
  const out = new Set();
  for (const m of q.matchAll(re)) out.add(m[1].trim());
  return [...out];
};

// ===== CSV: parser ligero (suficiente para CSV simples) =====
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line) => {
    // separador por comas básico + soporte para "comillas, con, comas"
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === "," && !inQ) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out.map((s) => s.replace(/^"|"$/g, ""));
  };
  const headers = split(lines[0]);
  const rows = lines.slice(1).map((l) => split(l));
  return { headers, rows };
}

function tableFromObjects(title, cols, dataRows) {
  return { title, columns: cols, rows: dataRows };
}

function numberOrNull(v) {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// promedio de <valCol> por <groupCol>
function avgBy(csv, valCol, groupCol) {
  const { headers, rows } = csv;
  const iV = headers.findIndex((h) => h.toLowerCase() === valCol.toLowerCase());
  const iG = headers.findIndex((h) => h.toLowerCase() === groupCol.toLowerCase());
  if (iV < 0 || iG < 0) return null;

  const map = new Map();
  for (const r of rows) {
    const g = r[iG];
    const n = numberOrNull(r[iV]);
    if (n == null) continue;
    const prev = map.get(g) || { sum: 0, c: 0 };
    prev.sum += n; prev.c += 1;
    map.set(g, prev);
  }
  const table = Array.from(map.entries())
    .map(([grp, { sum, c }]) => [grp, +(sum / c).toFixed(2)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return tableFromObjects(`Promedio de ${valCol} por ${groupCol}`, [groupCol, `prom_${valCol}`], table);
}

// top N (alta/baja) por columna numérica
function topN(csv, valCol, n = 5, order = "desc") {
  const { headers, rows } = csv;
  const idx = headers.findIndex((h) => h.toLowerCase() === valCol.toLowerCase());
  if (idx < 0) return null;

  const objs = rows.map((r) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = r[i]));
    obj.__v = numberOrNull(r[idx]);
    return obj;
  }).filter((o) => o.__v != null);

  objs.sort((a, b) => (order === "asc" ? a.__v - b.__v : b.__v - a.__v));
  const picked = objs.slice(0, n);

  const cols = headers; // muestra todas; puedes reducir si quieres
  const data = picked.map((o) => cols.map((c) => o[c]));
  return tableFromObjects(`Top ${n} por ${valCol} (${order})`, cols, data);
}

// ===== Normalizador de salida del modelo =====
function normalizeAnswer(rawText) {
  let obj = tryParseJSON(rawText);
  if (obj) return shape(obj, rawText);

  const m = rawText.match(/```json\s*([\s\S]*?)\s*```/i);
  if (m) {
    obj = tryParseJSON(m[1]);
    if (obj) return shape(obj, rawText);
  }
  const m2 = rawText.match(/\{[\s\S]*\}/);
  if (m2) {
    obj = tryParseJSON(m2[0]);
    if (obj) return shape(obj, rawText);
  }
  return { ok: true, general: stripFences(rawText), lists: [], tables: [] };
}
function tryParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function stripFences(s) { return String(s).replace(/```[\s\S]*?```/g, "").trim(); }
function shape(obj, rawText) {
  const out = { ok: true, general: "", lists: [], tables: [] };
  if (typeof obj.general === "string") out.general = obj.general;
  if (Array.isArray(obj.lists)) out.lists = obj.lists.filter((x) => x && Array.isArray(x.items));
  if (Array.isArray(obj.tables)) out.tables = obj.tables.filter((t) => t && Array.isArray(t.columns) && Array.isArray(t.rows));
  if (!out.tables.length && obj.columns && obj.rows) {
    out.tables.push({ title: obj.title || "Tabla", columns: obj.columns, rows: obj.rows });
  }
  if (!out.general) out.general = stripFences(obj.text || rawText || "");
  return out;
}

// ===== OpenAI =====
async function askOpenAI(prompt, context) {
  if (!OPENAI_API_KEY) {
    return normalizeAnswer(
      `{"general":"(Sin OPENAI_API_KEY) ${prompt}"}`
    );
  }
  const system = [
    "Eres un asistente que responde EXCLUSIVAMENTE en JSON.",
    'Forma exacta: {"general": string, "lists":[{"title":string,"items":string[]}], "tables":[{"title":string,"columns":string[],"rows":(string|number)[][]}]}',
    "No envuelvas en ``` ni agregues claves extra.",
  ].join(" ");

  const user = [
    "Pregunta del usuario:",
    prompt,
    "",
    "Contexto (archivos):",
    context.slice(0, 12000), // límite de seguridad
  ].join("\n\n");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  const js = await r.json().catch(() => ({}));
  const text =
    js?.choices?.[0]?.message?.content ??
    JSON.stringify(js, null, 2);

  return normalizeAnswer(text);
}

// ===== Rutas =====
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, pong: "🏓", region: process.env.FLY_REGION || null });
});

// Listar archivos
app.get("/api/files", adminOnly, async (_req, res) => {
  try {
    const files = await listFiles();
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Subir (reemplaza si el nombre coincide)
app.post("/api/files/upload", adminOnly, upload.array("files", 30), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ ok: false, error: "no_files" });
    const saved = req.files.map((f) => f.originalname);
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Borrar ?name=archivo.txt
app.delete("/api/files", adminOnly, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    const p = path.join(STORAGE, path.basename(name));
    await fs.promises.unlink(p);
    res.json({ ok: true, deleted: name });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ ok: false, error: "not_found" });
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Respuestas
app.get("/api/answer", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "missing_q" });

    const filesMentioned = pickFilenames(q);
    const filesExisting = await listFiles();
    const wanted = filesMentioned.filter((f) => filesExisting.includes(f));

    // Construye contexto a partir de archivos
    let context = "";
    const csvContexts = [];
    for (const f of wanted) {
      if (f.toLowerCase().endsWith(".txt")) {
        const t = await readTextSafe(f);
        if (t) context += `\n\n# ${f}\n${t.slice(0, 12000)}\n`;
      } else if (f.toLowerCase().endsWith(".csv")) {
        const t = await readTextSafe(f);
        if (t) {
          context += `\n\n# ${f}\n(Contenido CSV incluido)\n`;
          csvContexts.push({ name: f, csv: parseCSV(t) });
        }
      }
    }

    // Reglas rápidas para CSV (promedio / top)
    const tables = [];
    // promedio de XXX por YYY
    const mAvg = q.match(/promedio|media/i) && q.match(/de\s+(.+?)\s+por\s+(.+?)(\s+(según|segun|en)\s+|$)/i);
    if (mAvg && csvContexts.length) {
      const valCol = mAvg[1].trim();
      const grpCol = mAvg[2].trim();
      for (const c of csvContexts) {
        const t = avgBy(c.csv, valCol, grpCol);
        if (t) tables.push(t);
      }
    }

    // top N <alta/baja> por COL
    const mTop = q.match(/top\s+(\d+)/i);
    const mAlta = q.match(/(más|mas)\s+alta/i);
    const mBaja = q.match(/(más|mas)\s+baja/i);
    const mCol = q.match(/por\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ_ ]+)\)?$/i);
    if (mTop && (mAlta || mBaja) && mCol && csvContexts.length) {
      const n = parseInt(mTop[1], 10) || 5;
      const valCol = mCol[1].trim();
      const order = mBaja ? "asc" : "desc";
      for (const c of csvContexts) {
        const t = topN(c.csv, valCol, n, order);
        if (t) tables.push(t);
      }
    }

    // Si ya tenemos tablas útiles, devolvemos respuesta directa
    if (tables.length) {
      return res.json({
        ok: true,
        general: "Resultado calculado a partir de tus CSV.",
        lists: [],
        tables,
      });
    }

    // Si no, pedimos ayuda al modelo con contexto de archivos
    const ans = await askOpenAI(q, context || "(No hay contexto de archivos para esta consulta)");
    return res.json(ans);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`API ready on :${PORT} (region ${process.env.FLY_REGION || "?"}) storage=${STORAGE}`);
});
