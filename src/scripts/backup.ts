#!/usr/bin/env node
// Backup en caliente de la base SQLite con `VACUUM INTO` (atómico, no
// bloquea al servidor ni requiere pararlo mientras corre) — más seguro que
// copiar el archivo .sqlite a mano, que puede quedar inconsistente si hay
// una escritura en curso.
//
// Uso:
//   node dist/scripts/backup.js [directorio-de-salida]
//   DB_FILE=/ruta/a/otra.sqlite node dist/scripts/backup.js
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SOURCE = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'suscripciones.sqlite');
const OUT_DIR = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'backups');

if (!fs.existsSync(SOURCE)) {
  console.error(`No se encontró la base de datos en ${SOURCE}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(OUT_DIR, `suscripciones-${stamp}.sqlite`);

const db = new DatabaseSync(SOURCE, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

console.log(`Backup creado: ${dest}`);
