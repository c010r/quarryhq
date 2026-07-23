// Cliente Paddle Billing (v1 / api.paddle.com). Como Paddle soporta vendedores
// en Uruguay y Stripe no, esta es la pasarela efectiva del SaaS en producción.
// Sin la SDK oficial — fetch directo, HMAC-SHA256 timing-safe para webhooks.
//
// Variables de entorno:
//   PADDLE_API_KEY         API key generada en Paddle > Developer tools > Authentication
//   PADDLE_WEBHOOK_SECRET  endpoint_secret_key del notification destination (paddle.com > Developer tools > Notifications)
//   PADDLE_PRICE_PREMIUM   price_id (pri_...) del producto Individual mensual
//   PADDLE_PRICE_TEAM      price_id (pri_...) del producto Equipos mensual
//   PADDLE_ENV             'sandbox' | 'production'. En sandbox usar clave sk_test_... y el
//                          endpoint sandbox (https://api-sandboxapi.paddle.com)
//
// Si PADDLE_API_KEY no está definido, paddleEnabled() falso y el endpoint
// /api/billing/upgrade cae a Stripe (si está) o al flujo simulado.

const API_KEY = process.env.PADDLE_API_KEY ?? '';
const ENV = (process.env.PADDLE_ENV ?? 'production').toLowerCase();
const WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET ?? '';
const PREMIUM_PRICE = process.env.PADDLE_PRICE_PREMIUM ?? '';
const TEAM_PRICE = process.env.PADDLE_PRICE_TEAM ?? '';

export const paddleEnabled = () => API_KEY.length > 0;
export function planPriceId(plan: BillingPlan): string {
  return plan === 'team' ? TEAM_PRICE : PREMIUM_PRICE;
}

// Sandbox y producción usan hosts distintos. Paddle distingue con el prefijo
// de la API key (sk_test_ vs sk_live_) pero confiamos en PADDLE_ENV para
// simplificar; el usuario debe setearlo coherente con la key que está usando.
const API_BASE = ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';

export type BillingPlan = 'premium' | 'team';

async function paddleRequest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!paddleEnabled()) throw new Error('Paddle no configurado');
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.detail ?? data?.error?.message ?? `Paddle ${res.status}`;
    throw Object.assign(new Error(msg), { paddle: data?.error });
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Customers: solo guardamos customer_id la primera vez. Para checkout de
// primera suscripción lo dejamos en null y Paddle crea el customer desde el
// formulario de Checkout (email del usuario). Renovaciones posteriores ya
// vienen con el customer_id en el webhook.
// ---------------------------------------------------------------------------
async function ensureCustomerId(userId: number, email: string | null): Promise<string | null> {
  const { get, insert } = await import('./db.ts');
  const existing = await get<{ customer_id: string }>('SELECT customer_id FROM paddle_customers WHERE user_id = $1', [userId]);
  if (existing) return existing.customer_id;
  if (!email) return null;
  // Crea customer en Paddle y lo persiste para futuras operaciones. Sin email
  // podés omitir y dejar que Paddle lo haga en Checkout (devolvemos null).
  try {
    const c = await paddleRequest<any>('POST', '/customers', {
      email,
      custom_data: { user_id: String(userId) },
    });
    const cid = c.data?.id;
    if (cid) {
      await insert('INSERT INTO paddle_customers (user_id, customer_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET customer_id = EXCLUDED.customer_id',
        [userId, cid]);
    }
    return cid ?? null;
  } catch {
    // Si la creacion falla, devolvemos null y dejamos que Paddle cree el
    // customer en Checkout a partir del email tipeado — idempotente en el
    // webhook que dispara transaction.completed.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Checkout (Checkout hosted de Paddle): creamos una transaccion "draft" con
// el price_id del catalogo y currency_code USD; el campo customer_id es
// opcional (si null, el cliente completa email en Checkout). La respuesta
// trae data.checkout.url = payment link que usamos para redirigir.
// ---------------------------------------------------------------------------
export async function createCheckout(opts: {
  userId: number;
  plan: BillingPlan;
  customerEmail: string | null;
  appUrl: string;
}): Promise<{ url: string }> {
  const price = planPriceId(opts.plan);
  if (!price) throw new Error('Price ID de Paddle no configurado para este plan');
  const customerId = await ensureCustomerId(opts.userId, opts.customerEmail);
  const body: Record<string, unknown> = {
    items: [{ quantity: 1, price_id: price }],
    currency_code: 'USD',
    collection_mode: 'automatic',
    custom_data: { user_id: String(opts.userId), plan: opts.plan },
  };
  // El checkout url override es opcional; sin él, Paddle usa la Default
  // Payment Link configurada en el dashboard (https://sandbox-vendors.paddle.com/checkout).
  // Pasarlo acá evita que falle si no hay default, pero debe ser de un dominio
  // aprobado en Paddle > Checkout settings.
  body.checkout = { url: `${opts.appUrl}/#/billing/success` };
  if (customerId) body.customer_id = customerId;
  const txn = await paddleRequest<any>('POST', '/transactions', body);
  const url = txn.data?.checkout?.url;
  if (!url) throw new Error('Paddle no devolvió URL de checkout');
  return { url };
}

// ---------------------------------------------------------------------------
// Cancelar suscripción: PATCH /subscriptions/{id} con {status:'canceled'}.
// Paddle lanza luego el webhook subscription.canceled (cubre la degradación
// local del plan en el handler). Idempotente si ya está cancelada.
// ---------------------------------------------------------------------------
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await paddleRequest('PATCH', `/subscriptions/${subscriptionId}`, { status: 'canceled' });
}

// ---------------------------------------------------------------------------
// Verificación de webhook (raw body). Header formato: `ts=NNN;h1=HEX`. La
// firma es HMAC-SHA256(secret, `${ts}:${rawBodyUtf8}`) en hex. Comparamos con
// timingSafeEqual y toleramos hasta 5 min de desfasaje (más generosos que el
// default del SDK que es 5 s — en prod/nginx a veces hay retries).
// ---------------------------------------------------------------------------
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, toleranceSec = 300): any | null {
  if (!WEBHOOK_SECRET || !signatureHeader || !signatureHeader.includes(';')) return null;
  const parts: Record<string, string> = {};
  for (const seg of signatureHeader.split(';')) {
    const [k, v] = seg.trim().split('=');
    if (k && v) parts[k] = v;
  }
  const ts = parts.ts;
  const h1 = parts.h1;
  const tsSec = Number(ts);
  if (!h1 || !Number.isFinite(tsSec) || tsSec < 0) return null;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsSec) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(rawBody.toString('utf8')); } catch { return null; }
}

import crypto from 'node:crypto';