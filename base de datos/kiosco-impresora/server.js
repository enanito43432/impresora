/**
 * Sistema Kiosco de Impresión Autoservicio
 * Backend: Express + SQLite3 + bcrypt + pdf-lib
 *
 * Arrancar: node server.js  (o npm start)
 * URL:      http://localhost:3000
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'kiosco-secret-cambiar-en-produccion';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const USB_DIR = path.join(DATA_DIR, 'usb');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const DB_PATH = path.join(DATA_DIR, 'kiosco.db');

for (const dir of [DATA_DIR, USB_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ============================================================
 * BASE DE DATOS SQLITE
 * ============================================================ */
const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function initDb() {
  await dbRun(`CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    color_mode TEXT NOT NULL UNIQUE,
    price REAL NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    color_mode TEXT NOT NULL,
    duplex INTEGER NOT NULL,
    copies INTEGER NOT NULL,
    printed_pages TEXT NOT NULL,
    total_pages INTEGER NOT NULL,
    total_sheets INTEGER NOT NULL,
    total_price REAL NOT NULL,
    created_at TEXT NOT NULL
  )`);

  const row = await dbGet('SELECT COUNT(*) AS c FROM prices');
  if (row.c === 0) {
    await dbRun('INSERT INTO prices (color_mode, price) VALUES (?, ?)', ['BW', 50]);
    await dbRun('INSERT INTO prices (color_mode, price) VALUES (?, ?)', ['COLOR', 150]);
  }
}

async function getPrices() {
  const rows = await dbAll('SELECT color_mode, price FROM prices ORDER BY id');
  const map = {};
  rows.forEach(r => { map[r.color_mode] = r.price; });
  return { BW: map.BW != null ? map.BW : 50, COLOR: map.COLOR != null ? map.COLOR : 150 };
}

/* ============================================================
 * ARCHIVOS DEL USB (SIMULADOS)
 * ============================================================ */
const USB_FILES = {
  'Proyecto_Final_2026.pdf': { pages: 14, size: '2.8 MB' },
  'Curriculum_Vitae.pdf': { pages: 2, size: '0.45 MB' },
  'Contrato_Alquiler_Firmado.pdf': { pages: 6, size: '1.2 MB' }
};

// Genera los PDF de muestra la primera vez (para que el corte de páginas sea real)
async function ensureSamplePdfs() {
  for (const [name, meta] of Object.entries(USB_FILES)) {
    const filePath = path.join(USB_DIR, name);
    if (fs.existsSync(filePath)) continue;

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= meta.pages; i++) {
      const page = doc.addPage([595, 842]); // A4
      page.drawText(`${name}  -  Pagina ${i} de ${meta.pages}`, {
        x: 50, y: 780, size: 18, font, color: rgb(0.1, 0.1, 0.1)
      });
      page.drawText('Documento de demostracion generado por el kiosco.', {
        x: 50, y: 750, size: 11, font, color: rgb(0.35, 0.35, 0.35)
      });
    }
    fs.writeFileSync(filePath, await doc.save());
    console.log('[usb] PDF de muestra generado:', filePath);
  }
}

/* ============================================================
 * VALIDACIÓN DE SELECCIÓN DE PÁGINAS
 * ============================================================ */
function parsePageSelection(totalPages, input) {
  const parts = String(input).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: 'Ingrese al menos una página o rango.' };
  }

  const pages = new Set();

  for (const part of parts) {
    const range = part.split('-');

    if (range.length > 2) {
      return { ok: false, error: `Formato invalido en "${part}". Use ej: 1,3-5,8.` };
    }

    if (range.length === 1) {
      const n = Number(range[0]);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, error: `"${part}" no es una pagina valida.` };
      }
      if (n > totalPages) {
        return { ok: false, error: `El documento tiene ${totalPages} paginas. Revise la seleccion.` };
      }
      pages.add(n);
    } else {
      const a = Number(range[0]);
      const b = Number(range[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
        return { ok: false, error: `"${part}" no es un rango valido.` };
      }
      if (a > b) {
        return { ok: false, error: `Rango invalido en "${part}": el inicio no puede ser mayor que el fin.` };
      }
      if (b > totalPages) {
        return { ok: false, error: `El documento tiene ${totalPages} paginas. Revise la seleccion.` };
      }
      for (let i = a; i <= b; i++) pages.add(i);
    }
  }

  const list = [...pages].sort((a, b) => a - b);
  return { ok: true, list };
}

/* ============================================================
 * IMPRESIÓN REAL (best-effort con SumatraPDF)
 * ============================================================ */
function printPdf(filePath) {
  const sumatra = process.env.SUMATRA_PATH || 'SumatraPDF.exe';
  const printer = process.env.PRINTER_NAME;
  const args = printer
    ? ['-print-to', printer, '-silent', filePath]
    : ['-print-to-default', '-silent', filePath];

  execFile(sumatra, args, { timeout: 20000 }, (err) => {
    if (err) {
      console.log('[print] PDF cortado guardado en:', filePath);
      console.log('[print] (Instala SumatraPDF o definí SUMATRA_PATH en .env para impresion real)');
    } else {
      console.log('[print] Enviado a impresora:', filePath);
    }
  });
}

/* ============================================================
 * APP EXPRESS
 * ============================================================ */
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(express.static(PUBLIC_DIR));

const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).type('text/plain').send('ERROR: No autorizado');
}

/* ---------- TARIFAS ---------- */
app.get('/api/prices', async (req, res) => {
  try {
    const p = await getPrices();
    res.type('text/plain').send(`${p.BW},${p.COLOR}`);
  } catch (e) {
    console.error('[prices]', e);
    res.status(500).type('text/plain').send('ERROR: No se pudieron leer las tarifas');
  }
});

/* ---------- VALIDACIÓN DE PÁGINAS ---------- */
app.post('/api/validate-pages', (req, res) => {
  const filename = String(req.body.filename || '');
  const selection = String(req.body.pageSelection || '');
  const meta = USB_FILES[filename];

  if (!meta) return res.status(404).type('text/plain').send('ERROR: Archivo no encontrado');

  const r = parsePageSelection(meta.pages, selection);
  if (!r.ok) return res.status(400).type('text/plain').send('ERROR: ' + r.error);

  res.type('text/plain').send(`OK|${r.list.length}|${r.list.join(',')}`);
});

/* ---------- PROCESAR IMPRESIÓN ---------- */
app.post('/api/process-print', async (req, res) => {
  try {
    const filename = String(req.body.filename || '');
    const selection = String(req.body.pageSelection || '');
    const colorMode = String(req.body.colorMode || 'BW');
    const duplex = req.body.duplex === 'true' || req.body.duplex === '1' || req.body.duplex === true;
    const copies = Math.max(1, parseInt(req.body.copies, 10) || 1);

    const meta = USB_FILES[filename];
    if (!meta) return res.status(400).type('text/plain').send('ERROR: Archivo no encontrado');

    const r = parsePageSelection(meta.pages, selection);
    if (!r.ok) return res.status(400).type('text/plain').send('ERROR: ' + r.error);

    const prices = await getPrices();
    const unitPrice = colorMode === 'COLOR' ? prices.COLOR : prices.BW;
    const count = r.list.length;
    const totalPages = count * copies;
    const sheetsPerCopy = duplex ? Math.ceil(count / 2) : count;
    const totalSheets = sheetsPerCopy * copies;
    const totalPrice = totalPages * unitPrice;

    const txId = 'TX-' + Date.now().toString(36).toUpperCase() + '-' +
      Math.random().toString(36).slice(2, 6).toUpperCase();

    // Cortar el PDF real: solo las páginas seleccionadas, en orden
    const srcPath = path.join(USB_DIR, filename);
    const outPath = path.join(OUTPUT_DIR, `${txId}_${filename}`);
    const srcDoc = await PDFDocument.load(fs.readFileSync(srcPath));
    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(srcDoc, r.list.map(n => n - 1));
    copied.forEach(p => outDoc.addPage(p));
    fs.writeFileSync(outPath, await outDoc.save());

    await dbRun(
      `INSERT INTO sales (id, filename, color_mode, duplex, copies, printed_pages,
        total_pages, total_sheets, total_price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [txId, filename, colorMode, duplex ? 1 : 0, copies, selection,
        totalPages, totalSheets, totalPrice, new Date().toLocaleString('es-AR')]
    );

    printPdf(outPath);

    res.type('text/plain').send('OK|' + txId);
  } catch (e) {
    console.error('[process-print]', e);
    res.status(500).type('text/plain').send('ERROR: ' + (e.message || 'No se pudo procesar la impresion'));
  }
});

/* ---------- AUTH ADMIN ---------- */
app.get('/api/admin/check-auth', (req, res) => {
  res.type('text/plain').send(req.session && req.session.isAdmin ? 'AUTHENTICATED' : 'UNAUTHENTICATED');
});

app.post('/api/admin/login', async (req, res) => {
  const pass = String(req.body.password || '');
  const ok = await bcrypt.compare(pass, adminHash);
  if (ok) {
    req.session.isAdmin = true;
    res.type('text/plain').send('OK|' + Date.now());
  } else {
    res.status(401).type('text/plain').send('ERROR: Contrasena incorrecta.');
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.type('text/plain').send('OK');
  });
});

/* ---------- PANEL ADMIN ---------- */
app.get('/api/admin/dashboard-data', requireAdmin, async (req, res) => {
  try {
    const p = await getPrices();
    const sales = await dbAll('SELECT * FROM sales ORDER BY created_at DESC');
    let out = `PRICES|${p.BW}|${p.COLOR}`;
    for (const s of sales) {
      out += `\nSALE|${s.id}|${s.filename}|${s.color_mode}|${s.duplex}|${s.copies}|` +
        `${s.printed_pages}|${s.total_pages}|${s.total_sheets}|${s.total_price}|${s.created_at}`;
    }
    res.type('text/plain').send(out);
  } catch (e) {
    console.error('[dashboard]', e);
    res.status(500).type('text/plain').send('ERROR: No se pudieron leer los datos');
  }
});

app.post('/api/admin/prices', requireAdmin, async (req, res) => {
  const bw = Number(req.body.bw);
  const color = Number(req.body.color);
  if (!Number.isFinite(bw) || !Number.isFinite(color) || bw < 1 || color < 1) {
    return res.status(400).type('text/plain').send('ERROR: Las tarifas deben ser numeros mayores a 0');
  }
  try {
    await dbRun('UPDATE prices SET price = ? WHERE color_mode = ?', [bw, 'BW']);
    await dbRun('UPDATE prices SET price = ? WHERE color_mode = ?', [color, 'COLOR']);
    res.type('text/plain').send('OK');
  } catch (e) {
    console.error('[prices-save]', e);
    res.status(500).type('text/plain').send('ERROR: No se pudieron guardar las tarifas');
  }
});

app.post('/api/admin/clear-history', requireAdmin, async (req, res) => {
  try {
    await dbRun('DELETE FROM sales');
    res.type('text/plain').send('OK');
  } catch (e) {
    console.error('[clear]', e);
    res.status(500).type('text/plain').send('ERROR: No se pudo vaciar el historial');
  }
});

/* ============================================================
 * MERCADO PAGO — PENDIENTE DE CONEXIÓN
 * ------------------------------------------------------------
 * Cuando tengas el Access Token, agregar:
 *
 *   app.post('/api/mercado-pago/preference', (req, res) => {
 *     // 1) Crear la preferencia en el SERVIDOR con el token:
 *     //    mercadopago.preferences.create({ items: [{ title, unit_price, quantity }] })
 *     // 2) res.send('OK|' + preference.body.init_point)
 *   });
 *
 * El frontend redirige al init_point y Mercado Pago vuelve con
 * ?payment_id=...; recién ahí se llama a /api/process-print.
 * El Access Token NUNCA debe estar en el frontend.
 * ============================================================ */

/* ============================================================
 * ARRANQUE
 * ============================================================ */
(async () => {
  await initDb();
  await ensureSamplePdfs();
  app.listen(PORT, () => {
    console.log(`Kiosco de impresion corriendo en http://localhost:${PORT}`);
  });
})();
