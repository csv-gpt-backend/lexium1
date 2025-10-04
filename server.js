'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const multer = require('multer');
const OpenAI = require('openai');
const { parse: parseCSV } = require('csv-parse/sync');

const app = express();

const PORT = process.env.PORT || 8080;
const STORAGE_DIR = process.env.STORAGE_DIR || '/app/storage';
const TMP_DIR = path.join(STORAGE_DIR, '_tmp'); // tmp dentro del volumen
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

async function safeMove(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await fsp.rename(src, dest); }
  catch (e) {
    if (e && e.code === 'EXDEV') { await fsp.copyFile(src, dest); await fsp.unlink(src).catch(()=>{}); }
    else throw e;
  }
}
async function listFiles() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  const all = await fsp.readdir(STORAGE_DIR, { withFileTypes: true });
  return all.filter(d => d.isFile()).map(d => d.name).sort();
}

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

fs.mkdirSync(TMP_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + path.basename(file.originalname)),
});
const upload = multer({ storage });

app.get('/api/ping', (_req, res) => res.json({ ok: true, pong: '🏓' }));

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: 'admin_token_not_set' });
  const tok = req.get('x-admin-token');
  if (!tok || tok !== ADMIN_TOKEN) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}

app.get('/api/files', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, files: await listFiles() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});

app.post('/api/files/upload', requireAdmin, upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'no_files' });
    const saved = [];
    for (const it of files) {
      const tmpPath = it.path;
      const finalName = path.basename(it.originalname);
      const destPath = path.join(STORAGE_DIR, finalName);
      await safeMove(tmpPath, destPath);
      saved.push(finalName);
    }
    res.json({ ok: true, saved });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});

app.delete('/api/files/:name', requireAdmin, async (req, res) => {
  try {
    const name = req.params.name;
    if (!name || name.includes('..') || name.includes('/')) return res.status(400).json({ ok: false, error: 'bad_name' });
    await fsp.unlink(path.join(STORAGE_DIR, name));
    res.json({ ok: true, deleted: name });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'not_found' });
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

async function loadContextFromFiles(q) {
  const names = await listFiles();
  if (!names.length) return { names: [], text: '' };
  const ql = (q||'').toLowerCase();
  const order = [...names.filter(n => ql.includes(n.toLowerCase())), ...names.filter(n => !ql.includes(n.toLowerCase()))];
  let total = 0, chunks = []; const MAX = 80_000;
  for (const name of order) {
    try {
      const full = path.join(STORAGE_DIR, name);
      const ext = path.extname(name).toLowerCase();
      const buf = await fsp.readFile(full);
      let snippet = '';
      if (ext === '.csv') {
        const rows = parseCSV(buf.toString('utf8'), { skip_empty_lines: true });
        const head = rows[0] || [];
        const body = rows.slice(1, 61);
        const sample = body.map(r => { const o={}; head.forEach((h,i)=>o[String(h||`c${i+1}`)]=r[i]); return o; });
        snippet = `Archivo: ${name}\nFormato: CSV\nColumnas: ${JSON.stringify(head)}\nMuestras(<=60): ${JSON.stringify(sample)}\n`;
      } else {
        const t = buf.toString('utf8').replace(/\u0000/g, '');
        const trimmed = t.length > 20000 ? t.slice(0,20000) : t;
        snippet = `Archivo: ${name}\nContenido:\n${trimmed}\n`;
      }
      if (total + snippet.length > MAX) break;
      total += snippet.length; chunks.push(snippet);
    } catch {}
  }
  return { names, text: chunks.join('\n---\n') };
}

app.get('/api/answer', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'missing_q' });
    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'missing_openai_key' });

    const { names, text } = await loadContextFromFiles(q);
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const systemPrompt = `
Eres "Asistente Lexium". Responde en español SOLO con info de los archivos dados.
Si falta evidencia, dilo. Devuelve SIEMPRE un JSON así:
{"ok":true,"general":"...","lists":[{"title":"...","items":["a"]}],"tables":[{"title":"...","columns":["A"],"rows":[["1"]]}]}
Nada fuera del JSON.`.trim();

    const userPrompt = `
Pregunta: ${q}

Archivos:
${names.map(n=>`- ${n}`).join('\n') || '(ninguno)'}

Contenido (recortado):
${text || '(sin contenido)'}`.trim();

    const chat = await client.chat.completions.create({
      model: OPENAI_MODEL, temperature: 0.2,
      messages: [{ role:'system', content: systemPrompt }, { role:'user', content: userPrompt }]
    });

    const raw = (chat.choices?.[0]?.message?.content || '').trim();
    try { const json = JSON.parse(raw); return json && json.ok ? res.json(json) : res.json({ ok:true, general: raw, lists:[], tables:[] }); }
    catch { return res.json({ ok:true, general: raw, lists:[], tables:[] }); }
  } catch (e) { res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

(async () => {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  app.listen(PORT, () => console.log(`Lexium API :${PORT}`));
})();
