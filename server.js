// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const PORT = process.env.PORT || 8080;
const STORAGE = process.env.STORAGE_DIR || "/app/storage";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lexium123";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Asegura carpeta de storage
await fs.mkdir(STORAGE, { recursive: true });

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS flexible
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || CORS_ORIGINS.includes("*")) return cb(null, true);
      const ok = CORS_ORIGINS.some(allowed => {
        if (allowed.startsWith("https://*."))
          return origin === allowed.slice(0, 8) + origin.split("://")[1].split(".").slice(-2).join(".");
        return origin === allowed;
      });
      cb(null, ok);
    },
  })
);

// ---------- Utils ----------
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const toNum = (v) => {
  if (v === null || v === undefined) return NaN;
  const s = String(v).replace(",", ".").replace(/[^\d.\-]/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
};

const mean = (arr) => {
  const nums = arr.map(toNum).filter(Number.isFinite);
  if (!nums.length) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

const bucket = (n) => {
  if (!Number.isFinite(n)) return "Sin dato";
  if (n <= 40) return "BAJO";
  if (n <= 70) return "PROMEDIO";
  return "ALTO";
};

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// Copia segura (para EXDEV)
const safeWrite = async (destPath, buffer) => {
  const tmp = path.join(STORAGE, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, destPath).catch(async (e) => {
    // Si falla rename (EXDEV), hacemos copyFile
    await fs.copyFile(tmp, destPath);
    await fs.unlink(tmp).catch(() => {});
  });
};

// ---------- CSV ----------
async function loadCSV(name = "decimo.csv") {
  const filePath = path.join(STORAGE, name);
  if (!(await exists(filePath))) throw new Error(`No existe ${name} en storage.`);

  const raw = await fs.readFile(filePath, "utf8");

  // Normaliza saltos y detecta delimitador
  const lines = raw.replace(/\r/g, "").split("\n").filter(x => x.length);
  if (!lines.length) throw new Error("CSV vacío.");

  // Delimitador por conteo simple
  const first = lines[0];
  let delim = ",";
  const cntComma = (first.match(/,/g) || []).length;
  const cntSemi = (first.match(/;/g) || []).length;
  if (cntSemi > cntComma) delim = ";";

  const headers = first.split(delim).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(delim).map(p => p.replace(/^"(.*)"$/, "$1").trim());
    const row = {};
    headers.forEach((h, idx) => (row[h] = parts[idx] ?? ""));
    rows.push(row);
  }

  // Mapa de nombre normalizado -> clave original
  const headerMap = {};
  headers.forEach(h => (headerMap[norm(h)] = h));

  // Detecta columnas numéricas y castea
  for (const key of headers) {
    const sample = rows.slice(0, 20).map(r => toNum(r[key])).filter(n => !Number.isNaN(n));
    if (sample.length >= 3) {
      // Consideramos numérica si mayoría es número
      const numeric = sample.length >= 2;
      if (numeric) {
        for (const r of rows) {
          const n = toNum(r[key]);
          if (Number.isFinite(n)) r[key] = n;
        }
      }
    }
  }

  return {
    ok: true,
    delimiter: delim,
    count: rows.length,
    columns: headers,
    headerMap,
    rows,
    sample: rows.slice(0, 5),
  };
}

function findColumn(headers, cand) {
  const hmap = {};
  headers.forEach(h => (hmap[norm(h)] = h));
  return hmap[norm(cand)] || null;
}

function groupAverage(rows, groupKey, measureKey) {
  const map = new Map();
  for (const r of rows) {
    const g = r[groupKey];
    const v = toNum(r[measureKey]);
    if (!Number.isFinite(v)) continue;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(v);
  }
  const out = [];
  for (const [g, arr] of map.entries()) {
    out.push([g, Number(mean(arr).toFixed(1))]);
  }
  // Orden alfabético por grupo
  out.sort((a, b) => (String(a[0]).localeCompare(String(b[0]))));
  return out;
}

// ---------- TXT ----------
async function readTextBase(name) {
  const p = path.join(STORAGE, name);
  if (!(await exists(p))) return "";
  // Intentamos leer como UTF-8 "tal cual"
  return await fs.readFile(p, "utf8");
}

// ---------- Nombre tolerante ----------
function tokenizeName(s) {
  return norm(s).split(/\s+/).filter(Boolean);
}

function findBestStudent(rows, query) {
  const qn = norm(query);
  const exact = rows.find(r => norm(r.NOMBRE) === qn);
  if (exact) return { student: exact, suggestions: [] };

  const qTok = tokenizeName(qn);
  const scored = rows
    .map(r => {
      const nTok = tokenizeName(r.NOMBRE);
      let hits = 0;
      for (const qt of qTok) if (nTok.includes(qt)) hits++;
      return { r, hits };
    })
    .filter(x => x.hits > 0);

  scored.sort((a, b) => b.hits - a.hits || norm(a.r.NOMBRE).length - norm(b.r.NOMBRE).length);

  if (scored.length && scored[0].hits >= Math.min(qTok.length, 2)) {
    return { student: scored[0].r, suggestions: scored.slice(1, 6).map(x => x.r.NOMBRE) };
  }
  return { student: null, suggestions: scored.slice(0, 10).map(x => x.r.NOMBRE) };
}

// ---------- Multer (subida) ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Middleware admin ----------
function requireAdmin(req, res, next) {
  const tok = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: "admin_token_not_set" });
  if (tok !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "bad_admin_token" });
  next();
}

// ---------- API ----------
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, pong: "🏓", region: process.env.FLY_REGION || "unknown" });
});

// Lista de archivos
app.get("/api/files", async (req, res) => {
  try {
    const items = await fs.readdir(STORAGE);
    res.json({ ok: true, files: items.sort() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Sube archivos
app.post("/api/files/upload", requireAdmin, upload.array("files"), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ ok: false, error: "no_files" });
    const saved = [];
    for (const f of req.files) {
      const dest = path.join(STORAGE, f.originalname);
      await safeWrite(dest, f.buffer);
      saved.push(f.originalname);
    }
    res.json({ ok: true, files: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Borra archivo por nombre
app.delete("/api/files", requireAdmin, async (req, res) => {
  try {
    const name = String(req.query.name || "");
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    const p = path.join(STORAGE, name);
    if (!(await exists(p))) return res.json({ ok: true, deleted: false, message: "not_found" });
    await fs.unlink(p);
    res.json({ ok: true, deleted: true, name });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Debug CSV (estructura)
app.get("/api/csv", requireAdmin, async (req, res) => {
  try {
    const name = String(req.query.name || "decimo.csv");
    const csv = await loadCSV(name);
    res.json({
      ok: true,
      delimiter: csv.delimiter,
      count: csv.count,
      columns: csv.columns,
      sample: csv.sample,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Autocompletar estudiantes
app.get("/api/students", async (req, res) => {
  try {
    const { rows } = await loadCSV("decimo.csv");
    const q = (req.query.q || "").toString();
    if (!q) return res.json({ ok: true, count: rows.length, names: rows.map(r => r.NOMBRE).slice(0, 200) });

    const qTok = tokenizeName(q);
    let names = rows
      .map(n => n.NOMBRE)
      .map(n => ({ n, score: tokenizeName(n).filter(t => qTok.includes(t)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || norm(a.n).length - norm(b.n).length)
      .map(x => x.n);

    res.json({ ok: true, count: names.length, names: names.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ----- /api/answer -----
// Patrones soportados:
// 1) "muestra N filas de decimo.csv"
// 2) "promedio de {COLUMNA} por PARALELO|CURSO|CURSO y PARALELO según decimo.csv"
// 3) "top N estudiantes con {COLUMNA} más alta|baja según decimo.csv"
// 4) "explica ... según emocionales.txt|evaluacion.txt|ubicacion.txt"
app.get("/api/answer", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const nq = norm(q);

    // CSV principal
    const csv = await loadCSV("decimo.csv");
    const rows = csv.rows;
    const headers = csv.columns;

    const colByNorm = {};
    headers.forEach(h => (colByNorm[norm(h)] = h));

    // 1) Muestra N filas
    if (/muestra\s+\d+\s+filas/.test(nq) && nq.includes("decimo csv")) {
      const m = nq.match(/muestra\s+(\d+)\s+filas/);
      const k = m ? Math.max(1, Math.min(50, parseInt(m[1], 10))) : 3;
      const subsetCols = ["NOMBRE", "CURSO", "PARALELO", "AUTOESTIMA"].map(c => colByNorm[norm(c)] || c);
      const sample = rows.slice(0, k).map(r => subsetCols.map(c => r[c]));
      return res.json({
        ok: true,
        general: `Mostrando ${k} filas de decimo.csv`,
        tables: [{ title: "Muestra", columns: subsetCols, rows: sample }],
        lists: [],
      });
    }

    // Helpers para detectar columna de medida desde la pregunta
    function findMeasureFromQ() {
      // Busca por nombre de columna mencionado en la pregunta
      for (const h of headers) {
        if (nq.includes(norm(h))) return h;
      }
      // fallback común
      return colByNorm[norm("AUTOESTIMA")] || "AUTOESTIMA";
    }

    // 2) Promedio por grupo
    if (nq.includes("promedio") && nq.includes("segun decimo csv")) {
      const measure = findMeasureFromQ();

      let groupKey = null;
      if (nq.includes("por paralelo")) groupKey = colByNorm[norm("PARALELO")] || "PARALELO";
      else if (nq.includes("por curso")) groupKey = colByNorm[norm("CURSO")] || "CURSO";

      if (!groupKey) {
        return res.json({ ok: true, general: "Indica si es por CURSO o por PARALELO.", lists: [], tables: [] });
      }

      const table = groupAverage(rows, groupKey, measure);
      return res.json({
        ok: true,
        general: `Promedios de ${measure} por ${groupKey}.`,
        tables: [{ title: `Promedio de ${measure} por ${groupKey}`, columns: [groupKey, measure], rows: table }],
        lists: [],
      });
    }

    // 3) Top N ↑/↓
    if (nq.includes("top") && nq.includes("segun decimo csv")) {
      const m = nq.match(/top\s+(\d+)/);
      const k = m ? Math.max(1, Math.min(50, parseInt(m[1], 10))) : 5;

      const measure = findMeasureFromQ();
      const desc = nq.includes("mas alta") || nq.includes("más alta");
      const asc = nq.includes("mas baja") || nq.includes("más baja");

      const nameKey = colByNorm[norm("NOMBRE")] || "NOMBRE";
      const parKey = colByNorm[norm("PARALELO")] || "PARALELO";

      const data = rows
        .map(r => [r[nameKey], r[parKey], toNum(r[measure])])
        .filter(x => Number.isFinite(x[2]));

      data.sort((a, b) => (desc ? b[2] - a[2] : asc ? a[2] - b[2] : b[2] - a[2]));

      return res.json({
        ok: true,
        general: `Top ${k} estudiantes por ${measure} (${desc ? "más alta" : asc ? "más baja" : "ordenado"})`,
        tables: [{ title: "Top", columns: [nameKey, parKey, measure], rows: data.slice(0, k) }],
        lists: [],
      });
    }

    // 4) Lectura de TXT
    if (nq.includes("segun") && (nq.includes("emocionales txt") || nq.includes("evaluacion txt") || nq.includes("ubicacion txt"))) {
      let fname = "emocionales.txt";
      if (nq.includes("evaluacion txt")) fname = "evaluacion.txt";
      if (nq.includes("ubicacion txt")) fname = "ubicacion.txt";
      const txt = await readTextBase(fname);
      if (!txt) return res.json({ ok: true, general: `No encontré ${fname} en storage.`, tables: [], lists: [] });
      const preview = txt.slice(0, 1200);
      return res.json({
        ok: true,
        general: preview + (txt.length > 1200 ? " …" : ""),
        tables: [],
        lists: [],
      });
    }

    // Fallback
    return res.json({
      ok: true,
      general:
        "Pregunta recibida. Puedes pedir: “promedio de AUTOESTIMA por PARALELO según decimo.csv”, “muestra 3 filas de decimo.csv”, o referirte a evaluacion.txt/emocionales.txt/ubicacion.txt.",
      tables: [],
      lists: [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ----- /api/report -----
// q = "reporte completo de Castillo D Julia"
app.get("/api/report", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const nq = norm(q);

    // Extrae nombre después de "de"
    let person = q;
    const m = nq.match(/reporte\s+completo\s+de\s+(.+)/);
    if (m) person = q.slice(m.index + m[0].length).trim();

    const csv = await loadCSV("decimo.csv");
    const rows = csv.rows;
    const headers = csv.columns;

    const { student, suggestions } = findBestStudent(rows, person);
    if (!student) {
      return res.json({
        ok: true,
        general: `No encontré a '${person}' en decimo.csv.`,
        lists: suggestions.length ? [{ title: "¿Quizás te refieres a…?", items: suggestions }] : [],
        tables: [],
      });
    }

    // Claves reales
    const key = (name) => {
      const idx = headers.find(h => norm(h) === norm(name));
      return idx || name;
    };
    const K = {
      NOMBRE: key("NOMBRE"),
      CURSO: key("CURSO"),
      PARALELO: key("PARALELO"),
      IE: key("PROMEDIO DE INTELIGENCIA EMOCIONAL"),
    };

    // Dominios que ya vienen promediados (los mostramos tal cual)
    const DOMS = [
      "PROMEDIO DE HABILIDADES INTRAPERSONALES",
      "PROMEDIO DE HABILIDADES INTERPERSONALES",
      "PROMEDIO DE HABILIDADES PARA LA VIDA",
      "PROMEDIO DE INTELIGENCIA EMOCIONAL",
    ].map(key);

    // Habilidades base (scoring por alumno)
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

    // Datos del estudiante
    const nombre = student[K.NOMBRE];
    const curso = student[K.CURSO];
    const paralelo = student[K.PARALELO];
    const ie = toNum(student[K.IE]);

    // Fortalezas / Áreas
    const pares = HABS
      .filter(h => student[h] !== undefined && student[h] !== "")
      .map(h => [h, toNum(student[h])])
      .filter(([, v]) => Number.isFinite(v));

    const fortalezas = pares.filter(([, v]) => v >= 71).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, v]) => `${h}: ${v} (${bucket(v)})`);
    const mejoras = pares.filter(([, v]) => v <= 40).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([h, v]) => `${h}: ${v} (${bucket(v)})`);

    // Tabla de perfil
    const perfilRows = pares
      .sort((a, b) => b[1] - a[1])
      .map(([h, v]) => [h, v, bucket(v)]);

    // Tabla dominios
    const domRows = DOMS
      .map(d => [d, toNum(student[d]), bucket(toNum(student[d]))])
      .filter(r => Number.isFinite(r[1]));

    // Resumen general
    const general = `Informe socioemocional de ${nombre} (CURSO ${curso}, PARALELO ${paralelo}). IE Global: ${Number(ie.toFixed(1))} (${bucket(ie)}).`;

    const lists = [];
    if (fortalezas.length) lists.push({ title: "Fortalezas destacadas", items: fortalezas });
    if (mejoras.length) lists.push({ title: "Áreas de mejora prioritarias", items: mejoras });

    return res.json({
      ok: true,
      general,
      tables: [
        { title: "Perfil por Habilidad", columns: ["Habilidad", "Puntaje", "Rango"], rows: perfilRows },
        { title: "Dominios", columns: ["Dominio", "Puntaje", "Rango"], rows: domRows },
      ],
      lists,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- Arranque ----------
app.listen(PORT, () => {
  console.log(`API ready on :${PORT}`);
});
