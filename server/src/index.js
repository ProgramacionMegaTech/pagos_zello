import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { pool, initDb } from './db.js';

const {
  BEMOVIL_BASE_URL = 'https://apiv2.bemovil.net',
  BEMOVIL_TOKEN,
  BEMOVIL_SECRET_KEY,
  CHECKOUT_HOST = 'https://plataforma.bepay.com.co/checkout',
  PUBLIC_URL, // URL pública del backend (para confirmUrl), ej. https://xxxx.ngrok.app
  CLIENT_URL = 'http://localhost:5173',
  PORT = 4000,
} = process.env;

const LOG_FILE = process.env.WEBHOOK_LOG_FILE ?? '/app/logs/webhook.log';
fs.mkdirSync(LOG_FILE.replace(/\/[^/]+$/, ''), { recursive: true });

// Una línea JSON por notificación recibida (auditoría): headers, cuerpo crudo y
// payload interpretado. El header Authorization no se guarda (solo si coincide).
function logWebhook(req, valid, extra = {}) {
  const { authorization, ...headers } = req.headers;
  const line = JSON.stringify({
    receivedAt: new Date().toISOString(),
    ip: req.ip,
    signatureValid: valid,
    hasAuthorization: Boolean(authorization),
    headers,
    rawBody: req.rawBody ?? null,
    payload: req.body ?? null,
    ...extra,
  });
  fs.appendFile(LOG_FILE, line + '\n', (err) => err && console.error('log error', err));
}

// Un pago PENDING cuyo link ya venció se muestra como EXPIRADO
const STATUS = `CASE WHEN status = 'PENDING' AND transaction_id IS NULL AND COALESCE(expires_at, created_at + interval '15 minutes') < now()
  THEN 'EXPIRADO' ELSE status END AS status`;

// Métricas de la consulta de estado: intentos y ms desde la primera consulta hasta el estado definitivo
const METRICS = `check_attempts AS attempts,
  CASE WHEN first_check_at IS NULL THEN NULL
       ELSE (EXTRACT(EPOCH FROM (COALESCE(resolved_at, now()) - first_check_at)) * 1000)::int END AS elapsed_ms,
  resolved_at IS NOT NULL AS resolved`;

// BeMovil informa estados en español (p. ej. PENDIENTE); todo lo pendiente/en proceso no es definitivo
const isPending = (status) => /PEND|PROCES/.test(status);

const app = express();
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

// 1) Generar link de pago
app.post('/api/payments', async (req, res) => {
  const { name, label, description, price } = req.body ?? {};
  const amount = Number(price);
  if (!name || !label || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'name, label y price (> 0) son obligatorios' });
  }

  // ref: identifica el pago al volver del checkout (va en el redirectUrl)
  const ref = crypto.randomUUID();
  const payload = {
    isDefault: false,
    isUniquePayment: true,
    name,
    label,
    image: '',
    description: description ?? '',
    price: amount,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // expira a los 15 min
    redirectUrl: `${CLIENT_URL}/resultado?ref=${ref}`,
    confirmUrl: PUBLIC_URL ? `${PUBLIC_URL}/api/webhooks/bemovil` : '',
    // BeMovil devuelve _id y meta tal cual en el webhook: sirven para identificar el pago
    _id: ref,
    meta: { ref },
    additionalData: [],
  };

  try {
    const r = await fetch(`${BEMOVIL_BASE_URL}/api/v1/transactions/checkout/links/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEMOVIL_TOKEN}` },
      body: JSON.stringify({ data: payload }),
    });
    const body = await r.json().catch(() => ({}));
    const resource = body?.data?.Resource;
    if (!r.ok || !resource?.resourceKey) {
      return res.status(502).json({ error: body?.message || 'Error al generar el link', details: body });
    }

    const checkoutUrl = `${CHECKOUT_HOST}/${resource.resourceKey}`;
    const { rows } = await pool.query(
      `INSERT INTO payments (resource_key, bemovil_id, name, label, description, price, checkout_url, ref, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [resource.resourceKey, resource.id, name, label, payload.description, amount, checkoutUrl, ref, resource.expiresAt ?? payload.expiresAt],
    );
    res.status(201).json({ ...rows[0], bemovil: body }); // bemovil: respuesta original de BeMovil
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Últimas transacciones
app.get('/api/payments', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, price, ${STATUS}, ${METRICS}, created_at FROM payments ORDER BY created_at DESC LIMIT 20`,
  );
  res.json(rows);
});

// Guarda el estado de una transacción. Una APROBADA no se pisa con otra transacción
// (p. ej. un rechazo tardío de otro intento); repetir la misma transacción sí es válido.
async function applyStatus(payment, status, transactionId, matchedBy) {
  const locked = payment.status === 'APROBADA' && payment.transaction_id !== transactionId;
  if (!locked) {
    await pool.query(
      'UPDATE payments SET status=$1, transaction_id=$2, matched_by=$3, updated_at=now() WHERE id=$4',
      [status, transactionId, matchedBy, payment.id],
    );
  }
  return locked;
}

// Página de resultado: consulta el estado de la transacción en BeMovil (find) usando el _id (= ref)
app.post('/api/payments/ref/:ref/check', async (req, res) => {
  const { ref } = req.params;
  const startedAt = new Date(); // inicio del cronómetro si esta consulta llega a contar
  const confirmed = req.query.confirmed === '1'; // el usuario pulsó "Ya realicé el pago" (Nequi)
  const found = (await pool.query('SELECT id, status, transaction_id FROM payments WHERE ref = $1', [ref])).rows[0];
  if (!found) return res.status(404).json({ error: 'No encontrado' });

  let paymentMethodId = null;
  try {
    const r = await fetch(`${BEMOVIL_BASE_URL}/api/v1/transactions/find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEMOVIL_TOKEN}` },
      body: JSON.stringify({ data: { _id: ref } }),
    });
    const body = await r.json().catch(() => ({}));
    const tx = body?.data?.Transaction;
    if (tx) {
      paymentMethodId = tx.paymentMethodId ?? tx.PaymentMethod?.id ?? null;
      const status = String(tx.TransactionStatus?.name ?? 'UNKNOWN').toUpperCase();
      await applyStatus(found, status, tx.id, 'find');
    } else if (body?.errorCode !== 'transaction.notFound') {
      // Sin transacción todavía (el usuario no ha usado el link) es normal; otro error no
      console.error('find falló', r.status, body);
      return res.status(502).json({ error: 'No se pudo consultar el estado' });
    }
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'No se pudo consultar el estado' });
  }

  const current = (await pool.query(`SELECT ${STATUS} FROM payments WHERE id = $1`, [found.id])).rows[0].status;
  // Intentos y cronómetro: cada consulta cuenta y la primera inicia el reloj. Con Nequi Push (11)
  // pendiente solo cuentan las consultas posteriores a la confirmación del usuario.
  if (confirmed || !(paymentMethodId === 11 && isPending(current))) {
    await pool.query(
      'UPDATE payments SET check_attempts = check_attempts + 1, first_check_at = COALESCE(first_check_at, $2) WHERE id = $1',
      [found.id, startedAt],
    );
  }
  // Estado definitivo: se detiene el cronómetro (solo la primera vez); si sigue pendiente, sigue corriendo
  await pool.query(
    isPending(current)
      ? 'UPDATE payments SET resolved_at = NULL WHERE id = $1'
      : 'UPDATE payments SET resolved_at = COALESCE(resolved_at, now()) WHERE id = $1',
    [found.id],
  );
  const { rows } = await pool.query(
    `SELECT name, description, price, ${STATUS}, ${METRICS}, updated_at FROM payments WHERE id = $1`,
    [found.id],
  );
  const status = rows[0].status;
  // Nequi Push (11): el usuario aprueba en su celular y debe confirmar para volver a consultar
  const requiresManualCheck = paymentMethodId === 11 && isPending(status);
  res.json({ ...rows[0], paymentMethodId, requiresManualCheck });
});

// 2) Verificar estado del pago (estado local, actualizado por el webhook)
app.get('/api/payments/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT *, ${STATUS} FROM payments WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
});

// Webhook confirmUrl
function checkWebhook(req, d) {
  const auth = req.get('authorization');
  const sig = req.get('x-signature');
  const authOk = Boolean(BEMOVIL_SECRET_KEY) && auth === `Bearer ${BEMOVIL_SECRET_KEY}`;
  // `${id}.${reference}.${Amount.amount}`; BeMovil firma con la referencia vacía si no viene
  const expected = crypto
    .createHmac('sha256', BEMOVIL_SECRET_KEY ?? '')
    .update(`${d.id}.${d.reference ?? ''}.${d.Amount?.amount}`)
    .digest('hex');
  const a = Buffer.from(sig ?? '');
  const b = Buffer.from(expected);
  const sigOk = Boolean(sig) && a.length === b.length && crypto.timingSafeEqual(a, b);
  return { valid: authOk && sigOk, authOk, sigOk, hasSignature: Boolean(sig) };
}

app.post('/api/webhooks/bemovil', async (req, res) => {
  const d = req.body?.data ?? {};
  const check = checkWebhook(req, d);
  const valid = check.valid;
  await pool.query('INSERT INTO webhook_logs (payload, signature_valid) VALUES ($1,$2)', [req.body ?? {}, valid]);
  if (!valid) {
    logWebhook(req, false, { authOk: check.authOk, signatureOk: check.sigOk, hasSignature: check.hasSignature });
    return res.status(401).json({ ok: false });
  }

  const status = String(d.TransactionStatus?.name ?? 'UNKNOWN').toUpperCase();

  // El pago se identifica solo por _id: es el ref que enviamos al crear el link y BeMovil devuelve tal cual.
  const ref = d._id ?? null;
  const matchedBy = 'ref';
  const payment = ref
    ? (await pool.query('SELECT id, status, transaction_id FROM payments WHERE ref = $1 LIMIT 1', [String(ref)])).rows[0]
    : null;

  const locked = payment ? await applyStatus(payment, status, d.id, matchedBy) : false;
  if (payment) await pool.query('UPDATE payments SET last_webhook=$1 WHERE id=$2', [req.body, payment.id]);
  logWebhook(req, true, { matchedPayment: Boolean(payment), ignoredAlreadyApproved: locked });
  if (!payment) {
    console.warn('Webhook sin pago asociado', d.id);
    return res.status(404).json({ ok: false, error: 'Pago no encontrado' });
  }
  res.status(200).json({ ok: true });
});

await initDb();
app.listen(PORT, () => console.log(`API en :${PORT}`));
