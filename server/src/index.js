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
      `INSERT INTO payments (resource_key, bemovil_id, name, label, description, price, checkout_url, ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [resource.resourceKey, resource.id, name, label, payload.description, amount, checkoutUrl, ref],
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
    'SELECT id, name, description, price, status, created_at FROM payments ORDER BY created_at DESC LIMIT 20',
  );
  res.json(rows);
});

// Resultado para la página de retorno (solo campos públicos)
app.get('/api/payments/ref/:ref', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT name, description, price, status, updated_at FROM payments WHERE ref = $1',
    [req.params.ref],
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
});

// 2) Verificar estado del pago (estado local, actualizado por el webhook)
app.get('/api/payments/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
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
  const amount = Number(d.Amount?.amount);

  // Enlace con el pago: por reference (= resourceKey) o transaction_id ya conocido;
  // si no viene, se usa el único pago PENDIENTE con el mismo monto.
  const { rowCount } = await pool.query(
    `UPDATE payments SET status=$1, transaction_id=$2, last_webhook=$3, updated_at=now()
     WHERE id = (
       SELECT id FROM payments
       WHERE transaction_id = $2 OR resource_key = $4
          OR (status = 'PENDING' AND price = $5 AND transaction_id IS NULL
              AND (SELECT count(*) FROM payments WHERE status='PENDING' AND price=$5 AND transaction_id IS NULL) = 1)
       ORDER BY created_at DESC LIMIT 1
     )`,
    [status, d.id, req.body, d.reference ?? null, amount],
  );
  logWebhook(req, true, { matchedPayment: rowCount > 0 });
  if (!rowCount) console.warn('Webhook sin pago asociado', d.id);
  res.status(200).json({ ok: true });
});

await initDb();
app.listen(PORT, () => console.log(`API en :${PORT}`));
