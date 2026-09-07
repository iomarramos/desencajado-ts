// node:sqlite (DatabaseSync) es síncrono: una exportación de miles de filas
// bloquea el event loop entero mientras corre — con la base creciendo,
// nadie más puede recibir respuesta a NADA (ni siquiera algo tan liviano
// como consultar su propio saldo) mientras el admin exporta un CSV, y las
// conexiones SSE en vivo también se congelan ese rato, porque comparten el
// mismo hilo. Este worker corre esa consulta pesada en su propio hilo, con
// su propia conexión SQLite de solo lectura al mismo archivo — así el
// proceso principal sigue respondiendo con normalidad mientras tanto.
//
// Uso: new Worker(path.join(__dirname, 'exportWorker.js'), { workerData: { kind } })
// — el worker corre esta consulta una vez, postea el resultado y termina
// (no es un pool persistente: los exports son poco frecuentes y solo los
// dispara el admin, así que el costo de levantar un worker por request es
// insignificante comparado con el problema que resuelve).
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN_USERS_QUERY, ADMIN_PURCHASES_QUERY, ADMIN_REFERRALS_QUERY } from '../adminExportQueries';

const SOURCE = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'suscripciones.sqlite');

const QUERIES: Record<string, string> = {
  users: ADMIN_USERS_QUERY,
  purchases: ADMIN_PURCHASES_QUERY,
  referrals: ADMIN_REFERRALS_QUERY,
};

function run(): void {
  if (!parentPort) throw new Error('exportWorker debe correr como worker_thread');

  const kind = (workerData as { kind?: string } | undefined)?.kind;
  const query = kind ? QUERIES[kind] : undefined;
  if (!query) {
    parentPort.postMessage({ ok: false, error: `Export desconocido: ${kind}` });
    return;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(SOURCE, { readOnly: true });
    const rows = db.prepare(query).all();
    parentPort.postMessage({ ok: true, rows });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: (err as Error).message });
  } finally {
    db?.close();
  }
}

run();
