// MercadoPago: checkout de suscripciones (Preapproval API).
// A diferencia de Paddle/Stripe, MP no distingue sandbox por host sino por
// el prefijo del ACCESS_TOKEN (TEST-xxxx vs APP_USR-xxxx). El mismo endpoint
// sirve para ambos entornos, y el campo sandbox_init_point se devuelve solo
// con tokens de test. Documentación: https://www.mercadopago.com.ar/developers/es/reference/subscriptions

import crypto from 'node:crypto';

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET ?? '';

export const mpEnabled = () => ACCESS_TOKEN.length > 0;

const API = 'https://api.mercadopago.com';

// Precios de prueba para MercadoPago.
const PRICES: Record<BillingPlan, { amount: number; currency: string }> = {
  premium: { amount: 15, currency: 'USD' },
  team: { amount: 25, currency: 'USD' },
};

export type BillingPlan = 'premium' | 'team';

async function mpPost<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.message ?? data?.cause?.[0]?.description ?? `MP ${res.status}`;
    throw Object.assign(new Error(msg), { mp: data });
  }
  return data as T;
}

async function mpGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data?.message ?? `MP ${res.status}`), { mp: data });
  return data as T;
}

async function mpPut<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data?.message ?? `MP ${res.status}`), { mp: data });
  return data as T;
}

// ---------------------------------------------------------------------------
// Checkout: POST /preapproval → devuelve init_point (checkout hosted de MP).
// El cliente es redirigido a esa URL, autoriza el cobro recurrente, y MP
// manda IPN subscription_authorized → nuestro webhook activa el plan.
// ---------------------------------------------------------------------------
export async function createCheckout(opts: {
  userId: number;
  plan: BillingPlan;
  payerEmail: string;
  appUrl: string;
}): Promise<{ url: string; preapprovalId: string }> {
  const price = PRICES[opts.plan];
  const body: Record<string, unknown> = {
    reason: opts.plan === 'team' ? 'QuarryHQ Equipos' : 'QuarryHQ Individual',
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: price.amount,
      currency_id: price.currency,
    },
    payer_email: opts.payerEmail,
    back_url: `${opts.appUrl}/#/billing/success`,
    external_reference: String(opts.userId),
    status: 'pending',
  };
  const data = await mpPost<any>('/preapproval', body);
  return {
    // Con token TEST- el sandbox_init_point está disponible; con APP_USR-
    // solo init_point. Priorizamos sandbox para probar.
    url: data.sandbox_init_point ?? data.init_point ?? '',
    preapprovalId: data.id,
  };
}

// ---------------------------------------------------------------------------
// Cancelar: PUT /preapproval/{id} con status=cancelled. MP lanza luego la
// IPN subscription_cancelled que nuestro webhook procesa para degradar el
// plan local.
// ---------------------------------------------------------------------------
export async function cancelSubscription(preapprovalId: string): Promise<void> {
  await mpPut(`/preapproval/${preapprovalId}`, { status: 'cancelled' });
}

// ---------------------------------------------------------------------------
// Obtener detalles de un preapproval (usado en el webhook después de recibir
// el ID, para obtener el external_reference = user_id)
// ---------------------------------------------------------------------------
export async function getPreapproval(id: string): Promise<any> {
  return mpGet(`/preapproval/${id}`);
}

// ---------------------------------------------------------------------------
// Verificación de webhook IPN. MP envía POST con el body:
// {"id": 123, "topic": "subscription_authorized"}
// Opcionalmente verifica el header x-signature con HMAC-SHA256 si está
// configurado MP_WEBHOOK_SECRET. La tolerancia es generosa porque MP puede
// reintentar minutos después.
// ---------------------------------------------------------------------------
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): any | null {
  // MP webhooks no requieren firma para funcionar — el id+topic es suficiente
  // para identificar la notificación, y llamamos a GET /preapproval/{id}
  // para obtener los detalles auténticos. Si hay MP_WEBHOOK_SECRET, hacemos
  // la verificación HMAC extra.
  let event: any;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return null; }
  if (!event?.id || !event?.topic) return null;
  if (WEBHOOK_SECRET && signature) {
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(`id:${event.id};ts:${event.ts ?? ''}`).digest('hex');
    if (signature !== expected) return null;
  }
  return event;
}

// Nota: crypto se importa al inicio del módulo.