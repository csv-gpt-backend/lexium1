// server.js  (ESM)
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";          // ← ÚNICA importación de fs (promises)
import formidable from "formidable";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const PORT = process.env.PORT || 8080;
const STORAGE = process.env.STORAGE_DIR || "/app/storage";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// asegurar storage
await fs.mkdir(STORAGE, { recursive: true });

// ---------- CORS ----------
function originOk(origin) {
  if (!origin) return true;               // fetch desde mismo origen / curl
  if (CORS_ORIGINS.includes("*")) return true;
  return CORS_ORIGINS.some(pat => {
    if (pat.endsWith("*")) {
      const base = pat.slice(0, -1);
      return origin.startsWith(base);
    }
    return origin === pat;
  });
}
const app = express();
app.use((req, res, next) => {
  cors({
    origin: (origin, cb) => cb(originOk(origin) ? null : new Error("CORS"), true),
    credentials: false
  })(req, res, next);
});
app.use(express.json());

// ---------- Utils ----------
const requireAdmin = (req, res, next) => {
  if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: "admin_token_not_set" });
  const t = req.header("x-admin-token") || "";
  if (t !== ADMIN_TOKEN) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
};

const safeBase = name => path.basename(name || "").replace(/\.\.+/g, ".");
const filePath = name => path.join(STORAGE, safeBase(name));

// dividir línea CSV con comillas
function splitCSVLine(line, delimiter) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delimiter && !q) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// parse CSV (soporta ; o ,  y comillas)
function parseCSV(text, delimiter = ";") {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // BOM
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter(l => l.trim().length);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headersRaw = splitCSVLine(lines[0], delimiter);
  const headers = headersRaw.map(h => h.replace(/^"|"$/g, "").trim());
  const rows = lines.slice(1).map(line => {
    const cols = splitCSVLine(line, delimiter);
    const obj = {};
    headers.forEach((h, i) => {
      let v = cols[i] ?? "";
      if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/""/g, '"');
      obj[h] = v;
    });
    return obj;
  });
  return { headers, rows };
}

// detección de delimitador y lectura completa
async function loadCSV(name) {
  const full = await fs.readFile(filePath(name), "utf8");
  const first = (full.split(/\r?\n/).find(l => l.trim()) || "");
  const cntSemi = (first.match(/;/g) || []).length;
  const cntComma = (first.match(/,/g) || []).length;
  const delimiter = cntSemi >= cntComma ? ";" : ",";
  const parsed = parseCSV(full, delimiter);
  return { ...parsed, delimiter, count: parsed.rows.length };
}

// convertir texto a número (soporta “80”, “80,5”, “80.5”)
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  // quita espacios y caracteres no numéricos salvo coma/punto/signo
  let t = v.trim().replace(/[^\d,.\-+]/g, "");
  // si hay coma y no punto, usa coma como decimal
  if (t.includes(",") && !t.includes(".")) t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- Rutas ----------
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, pong: "🏓", region: process.env.FLY_REGION || null });
});

// lista archivos en /storage
app.get("/api/files", async (req, res) => {
  try {
    const all = await fs.readdir(STORAGE);
    res.json({ ok: true, files: all.sort() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// subir archivos (multipart) – clave: "files"
app.post("/api/files/upload", requireAdmin, (req, res) => {
  const form = formidable({
    multiples: true,
    uploadDir: STORAGE,
    keepExtensions: true,
    filename: (name, ext, part) => safeBase(part.originalFilename || part.newFilename || name + ext)
  });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) return res.status(400).json({ ok: false, error: String(err.message || err) });
      const picked = files.files;
      const arr = Array.isArray(picked) ? picked : (picked ? [picked] : []);
      const saved = [];
      for (const f of arr) {
        if (!f) continue;
        const tmp = f.filepath || f.path; // v3/v2 compat
        const fin = filePath(f.originalFilename || f.newFilename || f.name);
        try { await fs.rename(tmp, fin); }
        catch {
          await fs.copyFile(tmp, fin);
          await fs.unlink(tmp).catch(() => {});
        }
        saved.push(path.basename(fin));
      }
      res.json({ ok: true, files: saved });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
});

// borrar archivo por nombre
app.delete("/api/files", requireAdmin, async (req, res) => {
  try {
    const name = safeBase(req.query.name || "");
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    await fs.unlink(filePath(name));
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// depurar lectura de CSV
app.get("/api/debug/csv", requireAdmin, async (req, res) => {
  try {
    const name = safeBase(req.query.name || "decimo.csv");
    const { headers, rows, delimiter, count } = await loadCSV(name);
    res.json({
      ok: true,
      delimiter,
      columns: headers,
      count,
      sample: rows.slice(0, 5)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------------------------------------------
// /api/answer – intenciones básicas:
// 1) "promedio de AUTOESTIMA por PARALELO"
// 2) "muestra N filas de decimo.csv (...)" (opcional)
// 3) leer un TXT si se menciona (evaluacion.txt / emocionales.txt / ubicacion.txt)
// ---------------------------------------------
app.get("/api/answer", async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    // 1) Promedio AUTOESTIMA por PARALELO
    if (/promedio.*autoestima.*paralelo/i.test(q)) {
      const name = "decimo.csv";
      const { headers, rows } = await loadCSV(name);

      const hPar = headers.find(h => h.toUpperCase().includes("PARALELO"));
      const hAut = headers.find(h => h.toUpperCase().includes("AUTOESTIMA"));
      if (!hPar || !hAut) {
        return res.json({
          ok: true,
          general: "No se encontraron las columnas requeridas (PARALELO, AUTOESTIMA).",
          lists: [], tables: []
        });
      }

      const agg = new Map(); // paralelo -> {sum,count}
      for (const r of rows) {
        const par = String(r[hPar] ?? "").trim();
        const val = toNumber(r[hAut]);
        if (!Number.isFinite(val)) continue;
        const a = agg.get(par) || { sum: 0, count: 0 };
        a.sum += val; a.count += 1;
        agg.set(par, a);
      }

      if (agg.size === 0) {
        return res.json({
          ok: true,
          general: "No se encontraron valores numéricos para calcular el promedio con las columnas detectadas.",
          lists: [], tables: []
        });
      }

      const rowsOut = [...agg.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([par, x]) => [par, Number((x.sum / x.count).toFixed(1))]);

      return res.json({
        ok: true,
        general: "Promedio de AUTOESTIMA por PARALELO calculado a partir de decimo.csv.",
        lists: [],
        tables: [{
          title: "Promedio por paralelo",
          columns: ["PARALELO", "AUTOESTIMA_PROMEDIO"],
          rows: rowsOut
        }]
      });
    }

    // 2) Muestra N filas
    const mSample = q.match(/muestra\s+(\d+)\s+filas/i);
    if (mSample) {
      const n = Math.max(1, Math.min(20, Number(mSample[1])));
      const { headers, rows } = await loadCSV("decimo.csv");
      const sample = rows.slice(0, n).map(r => headers.map(h => r[h]));
      return res.json({
        ok: true,
        general: `Primeras ${n} filas de decimo.csv`,
        tables: [{ title: "Muestra", columns: headers, rows: sample }],
        lists: []
      });
    }

    // 3) TXT simple
    const mTxt = q.match(/\b(evaluacion|emocionales|ubicacion)\.txt\b/i);
    if (mTxt) {
      const name = mTxt[0].toLowerCase();
      try {
        const txt = await fs.readFile(filePath(name), "utf8");
        const snippet = txt.trim().split(/\n+/).slice(0, 3).join(" ");
        return res.json({ ok: true, general: snippet || `Leído ${name}.`, lists: [], tables: [] });
      } catch {
        return res.json({ ok: true, general: `No encontré ${name} en el servidor.`, lists: [], tables: [] });
      }
    }

    // fallback
    return res.json({
      ok: true,
      general: "Pregunta recibida. Puedes pedir: “promedio de AUTOESTIMA por PARALELO según decimo.csv”, “muestra 3 filas de decimo.csv”, o referirte a evaluacion.txt/emocionales.txt/ubicacion.txt.",
      lists: [], tables: []
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API ready on :${PORT}`);
});
