// server.js  —  Backend Lexium (Fly.io)
// Node >= 18 (CommonJS). Usa OpenAI y volumen montado en /app/storage

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const formidable = require('formidable');
const { OpenAI } = require('openai');
const { parse: parseCSV } = require('csv-parse/sync');

const app = express();

// --- Configuración ---
const PORT = process.env.PORT || 8080;
const STORAGE_DIR = process.env.STORAGE_DIR || '/app/storage';
const TMP_DIR = path.join(STORAGE_DIR, '_tmp'); // tmp dentro del volumen (mismo dispositivo)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // obligatorio para /api/files*
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // cámbialo si quieres
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- util: mover seguro (rename si se puede; si no, copy+unlink) ---
async function safeMove(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(src, dest); // rápido si es el mismo dispositivo
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await fsp.unlink(src).catch(() => {});
    } else {
      throw e;
    }
  }
}

// --- util: lista de archivos "reales" (omitimos directorios ocultos) ---
async function listFiles() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  const all = await fsp.readdir(STORAGE_DIR, { withFileTypes: true });
  return all
    .filter(d => d.isFile())
    .map(d => d.name)
    .sort();
}

// --- CORS ---
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
  })
);

// --- Body parsers ligeros (no para multipart) ---
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// --- ping ---
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, pong: '🏓' });
});

// --- guard de admin ---
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: 'admin_token_not_set' });
  }
  const tok = req.get('x-admin-token');
  if (!tok || tok !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// --- listar archivos ---
app.get('/api/files', requireAdmin, async (_req, res) => {
  try {
    const files = await listFiles();
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// --- subir archivos (multipart) ---
app.post('/api/files/upload', requireAdmin, async (req, res) => {
  try {
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const form = formidable({
      uploadDir: TMP_DIR,            // tmp dentro del volumen
      keepExtensions: true,
      multiples: true,
      maxFileSize: 200 * 1024 * 1024 // 200MB
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        return res.status(400).json({ ok: false, error: err.message || 'parse_error' });
      }

      // Normalizamos: puede venir "files" (array o single) o "file"
      let picked = [];
      const cand = files.files ?? files.file ?? files['files[]'];
      if (Array.isArray(cand)) picked = cand;
      else if (cand) picked = [cand];

      if (!picked.length) {
        return res.status(400).json({ ok: false, error: 'no_files' });
      }

      const saved = [];
      for (const it of picked) {
        const tmpPath = it.filepath || it.path; // formidable v2/v1
        const original = it.originalFilename || it.name || 'archivo';
        const finalName = path.basename(original);
        const destPath = path.join(STORAGE_DIR, finalName);
        await safeMove(tmpPath, destPath);
        saved.push(finalName);
      }
      res.json({ ok: true, saved });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// --- borrar archivo ---
app.delete('/api/files/:name', requireAdmin, async (req, res) => {
  try {
    const name = req.params.name;
    if (!name || name.includes('..') || name.includes('/')) {
      return res.status(400).json({ ok: false, error: 'bad_name' });
    }
    const p = path.join(STORAGE_DIR, name);
    await fsp.unlink(p);
    res.json({ ok: true, deleted: name });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// --- helper: carga contenido de archivos para contexto ---
async function loadContextFromFiles(q) {
  const names = await listFiles(); // todos los archivos guardados
  if (!names.length) return { names: [], text: '' };

  // Heurística simple: prioriza los que aparecen mencionados en la pregunta
  const qLower = (q || '').toLowerCase();
  const prioritized = [
    ...names.filter(n => qLower.includes(n.toLowerCase())),
    ...names.filter(n => !qLower.includes(n.toLowerCase()))
  ];

  // Cargamos hasta ~80k chars de contexto total
  let total = 0;
  const MAX_CHARS = 80_000;
  let chunks = [];

  for (const name of prioritized) {
    const full = path.join(STORAGE_DIR, name);
    const ext = path.extname(name).toLowerCase();
    let snippet = '';

    try {
      const buf = await fsp.readFile(full);
      if (ext === '.csv') {
        // Convertimos CSV a un JSON compacto (máx 60 filas)
        const rows = parseCSV(buf.toString('utf8'), { skip_empty_lines: true });
        const head = rows[0] || [];
        const body = rows.slice(1, 61);
        const sample = body.map(r => {
          const obj = {};
          head.forEach((h, i) => { obj[String(h || `c${i+1}`)] = r[i]; });
          return obj;
        });
        snippet = `Archivo: ${name}\nFormato: CSV\nColumnas: ${JSON.stringify(head)}\nMuestras(<=60): ${JSON.stringify(sample)}\n`;
      } else {
        const t = buf.toString('utf8').replace(/\u0000/g, '');
        const trimmed = t.length > 20000 ? t.slice(0, 20000) : t;
        snippet = `Archivo: ${name}\nContenido:\n${trimmed}\n`;
      }
    } catch {
      continue;
    }

    if (total + snippet.length > MAX_CHARS) break;
    total += snippet.length;
    chunks.push(snippet);
  }

  const text = chunks.join('\n---\n');
  return { names, text };
}

// --- /api/answer: pregunta usando archivos como contexto ---
app.get('/api/answer', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'missing_q' });

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'missing_openai_key' });
    }

    const { names, text } = await loadContextFromFiles(q);

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const systemPrompt = `
Eres "Asistente Lexium". Responde en español.
Usa EXCLUSIVAMENTE la información contenida en los archivos suministrados como contexto.
Si la evidencia no es suficiente, di claramente que faltan datos del CSV/TXT.
Devuelve SIEMPRE un JSON con esta forma EXACTA:

{
  "ok": true,
  "general": "texto breve y claro",
  "lists": [ { "title": "título", "items": ["a","b"] } ],
  "tables": [ { "title": "título", "columns": ["Col1","Col2"], "rows": [["a","b"]] } ]
}

Nada de texto fuera del JSON.
`;

    const userPrompt = `
Pregunta: ${q}

Archivos disponibles:
${names.map(n => `- ${n}`).join('\n') || '(ninguno)'}

Contenido (recortado para el contexto):
${text || '(sin contenido)'}
`;

    const chat = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    let raw = (chat.choices?.[0]?.message?.content || '').trim();

    // Intentamos parsear el JSON que devuelve el modelo
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && json.ok) {
        return res.json(json);
      }
      // Si no viene como se espera, lo envolvemos
      return res.json({ ok: true, general: raw, lists: [], tables: [] });
    } catch {
      // Si no es JSON, devolvemos el texto tal cual
      return res.json({ ok: true, general: raw, lists: [], tables: [] });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// --- Arrancar servidor ---
(async () => {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  app.listen(PORT, () => {
    console.log(`Lexium API escuchando en :${PORT}`);
  });
})();
