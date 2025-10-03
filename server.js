import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import OpenAI from 'openai';

const app = express();
app.use(express.json({ limit: '8mb' }));

// ===== Config =====
const PORT = process.env.PORT || 8080;
const STORAGE = process.env.STORAGE_PATH || '/app/storage'; // volumen persistente
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';          // para subir/borrar archivos
const ALLOWED = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// CORS: si no defines CORS_ORIGINS, por defecto permite todo (útil para pruebas)
const allowAll = ALLOWED.length === 0;
app.use(cors({
  origin: (origin, cb) => {
    if (allowAll || !origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  }
}));

// Asegurar carpeta de storage
fs.mkdirSync(STORAGE, { recursive: true });

// ===== Helpers =====
const listFiles = async () => (await fsp.readdir(STORAGE)).sort();

const readTxt = async (p) => fsp.readFile(p, 'utf8');

// Si tus CSV están en ISO-8859-1, luego lo adapto con iconv-lite; por ahora UTF-8.
const readCsv = async (p) => {
  const buf = await fsp.readFile(p);
  const text = buf.toString('utf8');
  return parse(text, { columns: true, skip_empty_lines: true });
};

// ===== Auth para endpoints de admin =====
const authAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token || req.body?.token;
  if (!ADMIN_TOKEN || token === ADMIN_TOKEN) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
};

// ===== Gestión de archivos (ADMIN) =====
app.get('/api/files', authAdmin, async (_req, res) => {
  const files = await listFiles();
  res.json({ ok: true, files });
});

app.delete('/api/files/:name', authAdmin, async (req, res) => {
  const p = path.join(STORAGE, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not_found' });
  await fsp.unlink(p);
  res.json({ ok: true, deleted: req.params.name });
});

const upload = multer({ dest: '/tmp' });
app.post('/api/files/upload', authAdmin, upload.array('files', 50), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ ok: false, error: 'no_files' });
    const saved = [];
    for (const f of req.files) {
      const final = path.join(STORAGE, f.originalname);
      await fsp.rename(f.path, final);
      saved.push(path.basename(final));
    }
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== /api/answer (formato que TU index espera) =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/api/answer', async (req, res) => {
  try {
    const q = (req.query?.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'missing_q' });

    // 1) Cargar TXT/CSV desde el volumen
    const files = await listFiles();
    const txts = files.filter(f => f.toLowerCase().endsWith('.txt'));
    const csvs = files.filter(f => f.toLowerCase().endsWith('.csv'));

    let contexto = '';
    for (const name of txts) {
      const p = path.join(STORAGE, name);
      const content = await readTxt(p);
      contexto += `\n\n[TXT:${name}]\n${content.slice(0, 20000)}`; // límite seguridad
    }
    for (const name of csvs) {
      const p = path.join(STORAGE, name);
      const rows = await readCsv(p);
      const preview = rows.slice(0, 80); // preview para no inflar la solicitud
      contexto += `\n\n[CSV:${name} PREVIEW 80 FILAS]\n${JSON.stringify(preview, null, 2)}`;
    }

    // 2) Prompt: obliga a responder JSON {general, lists, tables}
    const prompt = `
Eres Nexa. Responde en español.
Devuelve EXACTAMENTE un JSON con esta forma:
{
  "general": "texto breve claro",
  "lists": [{"title":"...", "items":["...","..."]}],
  "tables": [{"title":"...", "columns":["col1","col2"], "rows":[["v11","v12"],["v21","v22"]]}]
}
- Si no hay listas/tabla, usa [].
- Si comparas grupos, incluye al menos una tabla.
- No inventes datos fuera del contexto.

[CONTEXTO LOCAL]
${contexto}

[PREGUNTA]
${q}
`;

    const r = await openai.responses.create({
      model: "gpt-5.1-mini", // cambia luego si quieres gpt-5.1 / reasoning
      input: prompt
    });

    // 3) Normalizar salida hacia tu UI
    let payload = { general: "", lists: [], tables: [] };
    const text = (r.output_text || '').trim();

    try {
      const obj = JSON.parse(text);
      payload.general = typeof obj.general === 'string' ? obj.general : '';
      payload.lists = Array.isArray(obj.lists) ? obj.lists : [];
      payload.tables = Array.isArray(obj.tables) ? obj.tables : [];
    } catch {
      // si no vino JSON, devuélvelo como texto en "general"
      payload = { general: text || 'Sin respuesta', lists: [], tables: [] };
    }

    return res.json({ ok: true, ...payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message, general: "Error interno" });
  }
});

app.get('/api/ping', (_req, res) => res.json({ ok: true, pong: '🏓' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('API on :' + PORT);
});
