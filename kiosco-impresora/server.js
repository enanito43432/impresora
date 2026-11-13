require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const { PDFDocument } = require('pdf-lib');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURACIÓN DE MIDDLEWARES Y PARSERS
// ==========================================

// Usamos únicamente URL-encoded para recepción de datos (NO app.use(express.json()))
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Configuración de Sesión Segura
app.use(session({
  name: 'kiosco_session',
  secret: process.env.SESSION_SECRET || 'kiosco_secret_key_2026_no_json',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // Cambiar a true si se utiliza HTTPS
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 // 1 hora de sesión
  }
}));

// Rate Limiter: Protección contra ataques de fuerza bruta en login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Máximo 5 intentos por IP
  handler: (req, res) => {
    res.status(429).send("ERROR: Demasiados intentos fallidos. Intente de nuevo en 15 minutos.");
  }
});

// Middleware de Autenticación para Rutas Administrativas
function requireAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    next();
  } else {
    res.status(401).send("ERROR: No autorizado. Debe iniciar sesión como administrador.");
  }
}

// ==========================================
// BASE DE DATOS SQLITE (kiosco.db)
// ==========================================

const db = new sqlite3.Database(path.join(__dirname, 'kiosco.db'), (err) => {
  if (err) console.error("Error al abrir base de datos SQLite:", err);
  else console.log(" Base de Datos SQLite conectada correctamente.");
});

// Inicializar tablas SQL y contraseña administrativa inicial en hash
db.serialize(async () => {
  // Tabla de Precios
  db.run(`CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY,
    bw_price REAL NOT NULL,
    color_price REAL NOT NULL
  )`);

  // Tabla de Ventas / Auditoría
  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id TEXT NOT NULL,
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

  // Tabla de Configuración / Credenciales de Administrador
  db.run(`CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY,
    password_hash TEXT NOT NULL
  )`);

  // Insertar precios por defecto si no existen
  db.get("SELECT COUNT(*) AS count FROM prices", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO prices (id, bw_price, color_price) VALUES (1, 50.0, 150.0)");
    }
  });

  // Generar e insertar Hash seguro de TALLERES123 en SQLite si no existe
  db.get("SELECT COUNT(*) AS count FROM admin_config", async (err, row) => {
    if (row && row.count === 0) {
      const initialPass = process.env.ADMIN_INITIAL_PASSWORD || 'TALLERES123';
      const hash = await bcrypt.hash(initialPass, 10);
      db.run("INSERT INTO admin_config (id, password_hash) VALUES (1, ?)", [hash]);
    }
  });
});

// ==========================================
// ARCHIVOS PDF DE PRUEBA EN MEMORIA
// ==========================================

const mockFiles = {};

async function initMockFiles() {
  async function createSamplePdf(pageCount, title) {
    const pdfDoc = await PDFDocument.create();
    for (let i = 1; i <= pageCount; i++) {
      const page = pdfDoc.addPage([600, 400]);
      page.drawText(`${title} - Pagina ${i} de ${pageCount}`, { x: 50, y: 350, size: 24 });
    }
    return await pdfDoc.save();
  }

  mockFiles['Proyecto_Final_2026.pdf'] = {
    pages: 14,
    size: 2800000,
    buffer: await createSamplePdf(14, 'Proyecto Final 2026')
  };
  mockFiles['Curriculum_Vitae.pdf'] = {
    pages: 2,
    size: 450000,
    buffer: await createSamplePdf(2, 'Curriculum Vitae')
  };
  mockFiles['Contrato_Alquiler_Firmado.pdf'] = {
    pages: 6,
    size: 1200000,
    buffer: await createSamplePdf(6, 'Contrato Alquiler')
  };
}

initMockFiles().then(() => console.log(" Archivos PDF de prueba cargados en memoria."));

// ==========================================
// PARSER DE RANGOS DE PÁGINAS (SIN JSON)
// ==========================================

function parsePageSelection(input, totalDocPages) {
  if (!input || typeof input !== 'string' || !input.trim()) {
    return { valid: false, error: 'Debe ingresar al menos un número o rango de página.' };
  }

  const str = input.trim();
  if (!/^[0-9,\-\s]+$/.test(str)) {
    return { valid: false, error: 'Formato inválido. Solo se permiten números, comas y guiones (ej. 1,3-5).' };
  }

  const parts = str.split(',');
  const selectedPagesSet = new Set();

  for (let part of parts) {
    part = part.trim();
    if (!part) continue;

    if (part.includes('-')) {
      const rangeParts = part.split('-');
      if (rangeParts.length !== 2) {
        return { valid: false, error: `Rango mal formado: "${part}".` };
      }

      const start = parseInt(rangeParts[0], 10);
      const end = parseInt(rangeParts[1], 10);

      if (isNaN(start) || isNaN(end)) return { valid: false, error: `Rango inválido: "${part}".` };
      if (start <= 0 || end <= 0) return { valid: false, error: 'Las páginas deben ser números mayores a 0.' };
      if (start > end) return { valid: false, error: `Rango invertido "${start}-${end}".` };
      if (end > totalDocPages) return { valid: false, error: `La página ${end} no existe. El documento solo tiene ${totalDocPages} páginas.` };

      for (let p = start; p <= end; p++) selectedPagesSet.add(p);
    } else {
      const p = parseInt(part, 10);
      if (isNaN(p)) return { valid: false, error: `Valor no numérico: "${part}".` };
      if (p <= 0) return { valid: false, error: 'Las páginas deben ser números mayores a 0.' };
      if (p > totalDocPages) return { valid: false, error: `La página ${p} no existe. El documento solo tiene ${totalDocPages} páginas.` };
      selectedPagesSet.add(p);
    }
  }

  const pageList = Array.from(selectedPagesSet).sort((a, b) => a - b);
  if (pageList.length === 0) return { valid: false, error: 'No se seleccionó ninguna página válida.' };

  return { valid: true, pageList };
}

// ==========================================
// ENDPOINTS PÚBLICOS DEL KIOSCO (SIN JSON)
// ==========================================

app.use(express.static(path.join(__dirname, 'public')));

// Obtener precios vigentes desde la base de datos SQLite (Respuesta en texto plano separado por comas)
app.get('/api/prices', (req, res) => {
  db.get("SELECT bw_price, color_price FROM prices WHERE id = 1", (err, row) => {
    if (err || !row) return res.status(500).send("ERROR: Base de datos no disponible");
    // Formato de texto: BW_PRICE,COLOR_PRICE
    res.send(`${row.bw_price},${row.color_price}`);
  });
});

// Validar selección de páginas
app.post('/api/validate-pages', (req, res) => {
  const filename = req.body.filename;
  const pageSelection = req.body.pageSelection;

  if (!mockFiles[filename]) {
    return res.send("ERROR: Archivo no encontrado en USB.");
  }

  const totalDocPages = mockFiles[filename].pages;
  const result = parsePageSelection(pageSelection, totalDocPages);

  if (!result.valid) {
    return res.send(`ERROR: ${result.error}`);
  }

  // Formato de respuesta en texto: OK|CANTIDAD|PAGINAS_COMAS|TOTAL_DOC_PAGES
  res.send(`OK|${result.pageList.length}|${result.pageList.join(',')}|${totalDocPages}`);
});

// Procesar Pago e Impresión Real cortando el PDF
app.post('/api/process-print', async (req, res) => {
  try {
    const { filename, pageSelection, colorMode, duplex, copies } = req.body;

    if (!mockFiles[filename]) {
      return res.send("ERROR: Archivo no existe.");
    }

    const fileData = mockFiles[filename];
    const validation = parsePageSelection(pageSelection, fileData.pages);

    if (!validation.valid) {
      return res.send(`ERROR: ${validation.error}`);
    }

    const selectedPages = validation.pageList;
    const countSelected = selectedPages.length;
    const copiesNum = Math.max(1, parseInt(copies, 10) || 1);
    const isDuplex = duplex === 'true' || duplex === true;

    // Obtener precios vigentes de SQLite para calcular cobro
    db.get("SELECT bw_price, color_price FROM prices WHERE id = 1", async (err, row) => {
      if (err || !row) return res.send("ERROR: No se pudieron consultar las tarifas en SQLite.");

      const unitPrice = colorMode === 'BW' ? row.bw_price : row.color_price;
      const totalPagesToPrint = countSelected * copiesNum;
      const sheetsPerCopy = isDuplex ? Math.ceil(countSelected / 2) : countSelected;
      const totalSheets = sheetsPerCopy * copiesNum;
      const totalPrice = totalPagesToPrint * unitPrice;

      // RECORTAR EL ARCHIVO PDF REAL CON PDF-LIB
      const originalPdfDoc = await PDFDocument.load(fileData.buffer);
      const printedPdfDoc = await PDFDocument.create();

      const pageIndices = selectedPages.map(p => p - 1);
      const copiedPages = await printedPdfDoc.copyPages(originalPdfDoc, pageIndices);
      copiedPages.forEach(p => printedPdfDoc.addPage(p));
      const finalPdfBytes = await printedPdfDoc.save();

      const txId = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      const dateStr = new Date().toLocaleString('es-AR');
      const printedPagesStr = selectedPages.join(',');

      // INSERTAR VENTA EN BASE DE DATOS SQLITE
      const sql = `INSERT INTO sales 
        (tx_id, filename, color_mode, duplex, copies, printed_pages, total_pages, total_sheets, total_price, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      db.run(sql, [txId, filename, colorMode, isDuplex ? 1 : 0, copiesNum, printedPagesStr, totalPagesToPrint, totalSheets, totalPrice, dateStr], function(dbErr) {
        if (dbErr) return res.send("ERROR: Falló el registro en la base de datos.");

        // Formato de confirmación en texto plano
        res.send(`OK|${txId}|${filename}|${colorMode}|${isDuplex ? '1' : '0'}|${copiesNum}|${printedPagesStr}|${totalPagesToPrint}|${totalSheets}|${totalPrice}|${dateStr}`);
      });
    });

  } catch (err) {
    console.error('Error al procesar impresión:', err);
    res.send("ERROR: Error interno procesando el archivo PDF.");
  }
});

// ==========================================
// ENDPOINTS ADMINISTRATIVOS (SIN JSON)
// ==========================================

// Autenticación de Administrador
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = req.body.password;

  if (!password) {
    return res.send("ERROR: Ingrese la contraseña.");
  }

  db.get("SELECT password_hash FROM admin_config WHERE id = 1", async (err, row) => {
    if (err || !row) return res.send("ERROR: Error al consultar SQLite.");

    const match = await bcrypt.compare(password, row.password_hash);
    if (match) {
      req.session.isAdmin = true;
      res.send("OK: Autenticado correctamente.");
    } else {
      res.send("ERROR: Contraseña incorrecta.");
    }
  });
});

// Verificación de estado de sesión
app.get('/api/admin/check-auth', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.send("AUTHENTICATED");
  } else {
    res.send("UNAUTHENTICATED");
  }
});

// Cerrar sesión
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(err => {
    res.clearCookie('kiosco_session');
    res.send("OK: Sesión cerrada.");
  });
});

// [ PROTEGIDO ] Renderizar panel de control con métricas en formato HTML / Texto
app.get('/api/admin/dashboard-data', requireAdminAuth, (req, res) => {
  db.get("SELECT bw_price, color_price FROM prices WHERE id = 1", (errPrices, rowPrices) => {
    if (errPrices) return res.status(500).send("ERROR: No se pudieron leer las tarifas.");

    db.all("SELECT tx_id, filename, color_mode, duplex, copies, printed_pages, total_pages, total_sheets, total_price, created_at FROM sales ORDER BY id DESC", (errSales, rowsSales) => {
      if (errSales) return res.status(500).send("ERROR: No se pudo consultar el historial.");

      // Construimos una respuesta formateada en filas de texto delimitadas por pipe (|) y salto de línea (\n)
      let responseText = `PRICES|${rowPrices.bw_price}|${rowPrices.color_price}\n`;

      rowsSales.forEach(s => {
        responseText += `SALE|${s.tx_id}|${s.filename}|${s.color_mode}|${s.duplex}|${s.copies}|${s.printed_pages}|${s.total_pages}|${s.total_sheets}|${s.total_price}|${s.created_at}\n`;
      });

      res.send(responseText);
    });
  });
});

// [ PROTEGIDO ] Guardar nuevas tarifas en SQLite
app.post('/api/admin/prices', requireAdminAuth, (req, res) => {
  const bw = parseFloat(req.body.bw);
  const color = parseFloat(req.body.color);

  if (isNaN(bw) || isNaN(color) || bw <= 0 || color <= 0) {
    return res.send("ERROR: Las tarifas deben ser números mayores a 0.");
  }

  db.run("UPDATE prices SET bw_price = ?, color_price = ? WHERE id = 1", [bw, color], function(err) {
    if (err) return res.send("ERROR: Error al actualizar la base de datos.");
    res.send("OK: Tarifas actualizadas en SQLite.");
  });
});

// [ PROTEGIDO ] Vaciar el historial de ventas en SQLite
app.post('/api/admin/clear-history', requireAdminAuth, (req, res) => {
  db.run("DELETE FROM sales", function(err) {
    if (err) return res.send("ERROR: No se pudo vaciar la tabla de ventas.");
    res.send("OK: Historial de ventas vaciado.");
  });
});

app.listen(PORT, () => {
  console.log(` Servidor Kiosco corriendo sin JSON en http://localhost:${PORT}`);
});