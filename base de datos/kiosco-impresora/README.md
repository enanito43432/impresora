# Kiosco de Impresión Autoservicio

Sistema de autoservicio para impresión de PDF desde un pendrive: selección de páginas,
modo color, duplex, copias, cotización, pago y corte real del PDF.

## Arrancar

```bash
npm start
```

Después abrir http://localhost:3000

## Estructura

| Carpeta / archivo | Descripción |
|---|---|
| `server.js` | Backend Express + SQLite3 |
| `public/index.html` | Interfaz del kiosco y del panel admin |
| `data/kiosco.db` | Base de datos SQLite (precios y ventas) |
| `data/usb/` | PDF de muestra (se generan solos la primera vez) |
| `data/output/` | PDF cortados listos para imprimir |
| `.env` | Puerto, clave admin, secretos e impresora |

## Acceso al panel admin

- Usuario: no hace falta, solo contraseña.
- Contraseña: definida en `.env` (`ADMIN_PASSWORD`; actualmente `talleres1234`).

## Notas

- El "pendrive" está simulado: los botones cargan 3 PDF de muestra que el servidor
  genera en `data/usb/` si no existen.
- Al confirmar el pago, el servidor corta el PDF real con `pdf-lib` (solo las páginas
  elegidas) y lo guarda en `data/output/`.
- Para impresión física real: instalar [SumatraPDF](https://www.sumatrapdfreader.org/)
  y definir `SUMATRA_PATH` (y opcionalmente `PRINTER_NAME`) en `.env`.

## Mercado Pago (pendiente)

El pago está simulado. El punto de integración está marcado en
`server.js` y en `public/index.html` (`handleProcessPayment`). Cuando tengas el
Access Token, se crea la preferencia en el servidor y se redirige al `init_point`.
El token nunca debe estar en el frontend.
