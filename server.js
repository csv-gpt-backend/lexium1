import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ===== BASICS =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const STORAGE_DIR = process.env.STORAGE_DIR || "/app/storage"; // Fly volume
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lexium123";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

await fs.mkdir(STORAGE_DIR, { recursive: true });

// ===== APP =====
const app = express();
app.use(express.json());

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || CORS_ORIGINS.includes("*")) return cb(null, true);
      const ok = CORS_ORIGINS.some(allowed => {
        if (allowed.endsWith("*")) {
          // wildcard simple: https://*.vercel.app
          const base = allowed.slice(0, -1);
          return origin.startsWith(base);
        }
        return origin === allowed;
      });
      cb(null, ok);
    },
  })
);

// ===== Helpers =====
const upload = multer({ storage: multer.memoryStorage() });

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/\s+/g, " ")
    .trim();
}
function isAdmin(req) {
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}
function param(req, name, def = "") {
  return (req.query?.[name] ?? def).toString();
}
function toNum(x) {
  if (x === null || x === undefined) return NaN;
  const n = Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
function bucket(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return "—";
  if (n <= 40) return "Bajo (1–40)";
  if (n <= 70) return "Promedio (41–70)";
  return "Alto (71–100)";
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
function mean(nums) {
  const vals = nums.map(toNum).filter(Number.isFinite);
  if (!vals.length) return NaN;
  return Math.round((vals.reduce((a,b)=>a+b,0)/vals.length) * 10) / 10;
}

// ===== CSV loader (auto ; o ,) =====
async function loadCSV(filename) {
  const full = path.join(STORAGE_DIR, filename);
  const raw = await fs.readFile(full, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .filter(l => l.trim().length)
    .map(l => l.replace(/\uFEFF/g, "")); // quita BOM si existe

  if (!lines.length) return { columns: [], rows: [], delimiter: "," };

  // detecta delimitador
  const first = lines[0];
  const delimiter = first.includes(",") && !first.includes(";") ? ","
                   : first.includes(";") && !first.includes(",") ? ";"
                   : (first.split(",").length >= first.split(";").length ? "," : ";");

  const headers = first.split(delimiter).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const parts = l.split(delimiter).map(s => s.trim());
    const obj = {};
    headers.forEach((h, i) => (obj[h] = parts[i] ?? ""));
    return obj;
  });
  return { columns: headers, rows, delimiter };
}

// ===== Files =====
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, pong: "🏓", region: process.env.PRIMARY_REGION || "?" });
});

app.get("/api/files", async (req, res) => {
  try {
    const entries = await fs.readdir(STORAGE_DIR, { withFileTypes: true });
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/files/upload", upload.array("files"), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!req.files?.length) return res.status(400).json({ ok: false, error: "no_files" });

    const saved = [];
    for (const f of req.files) {
      const dest = path.join(STORAGE_DIR, f.originalname);
      await fs.writeFile(dest, f.buffer);
      saved.push(f.originalname);
    }
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.delete("/api/files", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    const name = param(req, "name");
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    await fs.unlink(path.join(STORAGE_DIR, name));
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/debug/csv", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    const name = param(req, "name", "decimo.csv");
    const { columns, rows, delimiter } = await loadCSV(name);
    res.json({
      ok: true,
      delimiter,
      columns,
      count: rows.length,
      sample: rows.slice(0, 5),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== Domain config =====
const DOM_INDIVIDUALES = [
  "AUTOESTIMA",
  "MANEJO DE LA TENSIÓN",
  "BIENESTAR FÍSICO",
  "ASERTIVIDAD",
  "CONCIENCIA DE LOS DEMÁS",
  "EMPATÍA",
  "MOTIVACIÓN",
  "COMPROMISO",
  "ADMINISTRACIÓN DEL TIEMPO",
  "TOMA DE DECISIONES",
  "LIDERAZGO",
];

const DOM_PROMEDIOS = [
  "PROMEDIO DE HABILIDADES INTRAPERSONALES",
  "PROMEDIO DE HABILIDADES INTERPERSONALES",
  "PROMEDIO DE HABILIDADES PARA LA VIDA",
  "PROMEDIO DE INTELIGENCIA EMOCIONAL",
];

// ===== /api/answer (consultas rápidas) =====
app.get("/api/answer", async (req, res) => {
  try {
    const q = param(req, "q");
    const { rows, columns } = await loadCSV("decimo.csv");
    if (!rows.length) {
      return res.json({ ok: true, general: "No hay filas en decimo.csv.", lists: [], tables: [] });
    }

    // 1) muestra N filas
    {
      const m = q.match(/muestra\s+(\d+)\s+filas?\s+de\s+decimo\.csv/i);
      if (m) {
        const n = Math.max(1, Math.min(50, Number(m[1] || 3)));
        const subset = rows.slice(0, n).map(r => pick(r, ["NOMBRE", "CURSO", "PARALELO"]));
        return res.json({
          ok: true,
          general: `Primeras ${n} filas de decimo.csv.`,
          lists: [],
          tables: [
            {
              title: `Muestra (${n})`,
              columns: ["NOMBRE", "CURSO", "PARALELO"],
              rows: subset.map(r => [r.NOMBRE, r.CURSO, r.PARALELO]),
            },
          ],
        });
      }
    }

    // 2) promedio de X por [PARALELO|CURSO|GLOBAL]
    {
      const m = q.match(/promedio\s+de\s+(.+?)\s+por\s+(PARALELO|CURSO|GLOBAL)\s+seg[uú]n\s+decimo\.csv/i);
      if (m) {
        const col = m[1].toUpperCase().trim();
        const group = m[2].toUpperCase();

        if (!columns.includes(col)) {
          return res.json({
            ok: true,
            general: `Columna '${col}' no encontrada.`,
            lists: [],
            tables: [],
          });
        }

        if (group === "GLOBAL") {
          const avg = mean(rows.map(r => r[col]));
          return res.json({
            ok: true,
            general: `Promedio global de ${col} calculado a partir de decimo.csv.`,
            lists: [],
            tables: [
              { title: "Global", columns: ["Métrica", "Promedio"], rows: [[col, isNaN(avg) ? "—" : avg]] },
            ],
          });
        }

        const groups = by(rows, group);
        const trows = [];
        for (const [gkey, arr] of groups) {
          const avg = mean(arr.map(r => r[col]));
          trows.push([gkey, isNaN(avg) ? "—" : avg]);
        }
        trows.sort((a, b) => ("" + a[0]).localeCompare("" + b[0]));

        return res.json({
          ok: true,
          general: `Promedio de ${col} por ${group} calculado a partir de decimo.csv.`,
          lists: [],
          tables: [{ title: `${group}`, columns: [group, "Promedio"], rows: trows }],
        });
      }
    }

    // fallback
    return res.json({
      ok: true,
      general:
        "Pregunta recibida. Puedes pedir: “promedio de AUTOESTIMA por PARALELO según decimo.csv”, “muestra 3 filas de decimo.csv”, o pedir un reporte: “reporte completo de NOMBRE”.",
      lists: [],
      tables: [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== /api/report =====
app.get("/api/report", async (req, res) => {
  try {
    const q = param(req, "q");
    const { rows, columns } = await loadCSV("decimo.csv");
    if (!rows.length) {
      return res.json({ ok: true, general: "No hay datos en decimo.csv.", lists: [], tables: [] });
    }

    // extrae nombre tras "de ..."
    let person = "";
    const m = q.match(/de\s+(.+)$/i);
    if (m) person = m[1].trim();
    if (!person) {
      return res.json({ ok: true, general: "Indica el nombre: ‘reporte completo de <Nombre>’.", lists: [], tables: [] });
    }

    const wanted = norm(person);
    const idx = rows.findIndex(r => norm(r.NOMBRE) === wanted);
    const student = idx >= 0 ? rows[idx] : null;
    if (!student) {
      return res.json({ ok: true, general: `No encontré a '${person}' en decimo.csv.`, lists: [], tables: [] });
    }

    const curso = student.CURSO || "—";
    const paralelo = student.PARALELO || "—";

    // fortalezas / áreas (sobre dominios individuales)
    const scores = [];
    for (const col of DOM_INDIVIDUALES) {
      if (!columns.includes(col)) continue;
      const val = toNum(student[col]);
      if (Number.isFinite(val)) scores.push({ col, val });
    }
    // ordenar por valor
    scores.sort((a, b) => b.val - a.val);
    const fortalezas = scores.slice(0, 3).map(s => `${s.col}: ${s.val} (${bucket(s.val)})`);
    const mejoras    = scores.slice(-3).sort((a,b)=>a.val-b.val).map(s => `${s.col}: ${s.val} (${bucket(s.val)})`);

    // tabla de todas las métricas para el estudiante
    const tablaAlumno = [];
    for (const col of [...DOM_INDIVIDUALES, ...DOM_PROMEDIOS]) {
      if (!columns.includes(col)) continue;
      const val = toNum(student[col]);
      tablaAlumno.push([col, Number.isFinite(val) ? val : "—", bucket(val)]);
    }

    // promedios por cohorte (mismo CURSO/PARALELO)
    const cohort = rows.filter(r => r.CURSO === curso && r.PARALELO === paralelo);
    const tablaCohorte = [];
    for (const col of [...DOM_INDIVIDUALES, ...DOM_PROMEDIOS]) {
      if (!columns.includes(col)) continue;
      const avg = mean(cohort.map(r => r[col]));
      tablaCohorte.push([col, isNaN(avg) ? "—" : avg]);
    }

    // IE global si existe columna (usa PROMEDIO DE INTELIGENCIA EMOCIONAL)
    let ieGlobal = null;
    if (columns.includes("PROMEDIO DE INTELIGENCIA EMOCIONAL")) {
      const v = toNum(student["PROMEDIO DE INTELIGENCIA EMOCIONAL"]);
      if (Number.isFinite(v)) ieGlobal = v;
    }

    const general = [
      `Reporte socioemocional de ${student.NOMBRE} (CURSO ${curso}, PARALELO ${paralelo}).`,
      ieGlobal != null ? `Índice emocional global: ${ieGlobal} (${bucket(ieGlobal)}).` : "",
      fortalezas.length ? `Fortalezas destacadas: ${fortalezas.join("; ")}.` : "",
      mejoras.length ? `Áreas de oportunidad: ${mejoras.join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return res.json({
      ok: true,
      general,
      lists: [
        { title: "Fortalezas (Top 3)", items: fortalezas },
        { title: "Áreas de mejora (Bottom 3)", items: mejoras },
      ],
      tables: [
        { title: `Perfil de ${student.NOMBRE}`, columns: ["Dominio", "Puntaje", "Rango"], rows: tablaAlumno },
        { title: `Promedios del cohorte (CURSO ${curso} / PARALELO ${paralelo})`, columns: ["Dominio", "Promedio"], rows: tablaCohorte },
      ],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`API ready on :${PORT}`);
});
