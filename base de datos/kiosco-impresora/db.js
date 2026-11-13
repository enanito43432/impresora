/**
 * Utilidad de consola para inspeccionar la base de datos del kiosco.
 *
 * Uso:
 *   node db.js prices       -> tarifas vigentes
 *   node db.js sales        -> historial de ventas
 *   node db.js stats        -> resumen (trabajos, recaudacion, hojas, paginas)
 *   node db.js clear-sales  -> vacia el historial de ventas
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data', 'kiosco.db');
const cmd = process.argv[2] || 'stats';

const db = new sqlite3.Database(DB_PATH);

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

(async () => {
  switch (cmd) {
    case 'prices':
      console.table(await all('SELECT * FROM prices ORDER BY id'));
      break;

    case 'sales':
      console.table(await all('SELECT * FROM sales ORDER BY created_at DESC'));
      break;

    case 'stats': {
      const prices = await all('SELECT color_mode, price FROM prices ORDER BY id');
      const agg = await all(`SELECT COUNT(*) AS jobs,
        COALESCE(SUM(total_price), 0) AS revenue,
        COALESCE(SUM(total_sheets), 0) AS sheets,
        COALESCE(SUM(total_pages), 0) AS pages
        FROM sales`);
      console.log('Tarifas:', prices);
      console.log('Resumen:', agg[0]);
      break;
    }

    case 'clear-sales':
      await run('DELETE FROM sales');
      console.log('Historial de ventas eliminado.');
      break;

    default:
      console.log('Comandos disponibles: prices | sales | stats | clear-sales');
  }

  db.close();
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
