// Cliente Stripe minimal: sin la SDK oficial, conversemos directo con la REST
// API v1 con fetch. Solo implementamos lo que QuarryHQ usa: crear Checkout
// Sessions (suscripción mensual), Billing Portal y verificar la firma de los
// webhooks. Si STRIPE_SECRET_KEY no está definido, billing real queda
// deshabilitado y el endpoint /api/billing/upgrade cae al flujo simulado.

const SECRET = process.env.STRIPE_SECRET_KEY ?? '';
export const stripeEnabled = () => SECRET.length > 0;

// Price IDs de Stripe (configurados por el admin del SaaS una sola vez en
// https://dashboard.stripe.com/products), uno por plan. Recurrente mensual.
const PREMIUM_PRICE = process.env.STRIPE_PRICE_PREMIUM ?? '';
const TEAM_PRICE = process.env.STRIPE_PRICE_TEAM ?? '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

export type BillingPlan = 'premium' | 'team';

export function planPriceId(plan: BillingPlan): string {
  return plan === 'team' ? TEAM_PRICE : PREMIUM_PRICE;
}

const API = 'https://api.stripe.com/v1';

async function stripePost(path: string, params: Record<string, string | undefined>): Promise<any> {
  if (!stripeEnabled()) throw new Error('Stripe no configurado');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, v);
  // Soporta params anidados simples (p. ej. "line_items[0][price]") tal cual.
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message ?? `Stripe ${res.status}`;
    throw Object.assign(new Error(msg), { stripe: data?.error });
  }
  return data;
}

// Crea o recupera el Customer del usuario (idempotente por user_id; el
// customer_id se reutiliza en futuras suscripciones y para el Billing Portal).
export async function ensureCustomer(userId: number, email: string | null, name: string | null): Promise<string> {
  const { get, run, insert } = await import('./db.ts');
  const existing = await get<{ customer_id: string }>('SELECT customer_id FROM stripe_customers WHERE user_id = $1', [userId]);
  if (existing) return existing.customer_id;
  const params: Record<string, string> = { metadata_user_id: String(userId) };
  if (email) params.email = email;
  if (name) params.name = name;
  const c = await stripePost('/customers', params);
  await insert('INSERT INTO stripe_customers (user_id, customer_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET customer_id = EXCLUDED.customer_id',
    [userId, c.id]);
  return c.id;
}

// Checkout Session: redirige al hosted de Stripe. success/cancel apuntan a
// rutas del SPA; client_reference_id vuelve en el webhook para asociar el pago
// al usuario sin necesidad de lookup por email.
export async function createCheckoutSession(opts: {
  userId: number;
  plan: BillingPlan;
  customerEmail: string | null;
  customerName: string | null;
  appUrl: string;
}): Promise<{ url: string }> {
  const customerId = await ensureCustomer(opts.userId, opts.customerEmail, opts.customerName);
  const price = planPriceId(opts.plan);
  if (!price) throw new Error('Price ID de Stripe no configurado para este plan');
  const s = await stripePost('/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    client_reference_id: String(opts.userId),
    metadata_user_id: String(opts.userId),
    metadata_plan: opts.plan,
    subscription_data_metadata_user_id: String(opts.userId),
    subscription_data_metadata_plan: opts.plan,
    success_url: `${opts.appUrl}/#/billing/success`,
    cancel_url: `${opts.appUrl}/#/billing/cancel`,
  });
  return { url: s.url };
}

// Portal de auto-gestión: el cliente gestiona su método de pago, ve facturas y
// cancela sin tocar la app. Requiere un Customer configurado en Stripe
// (https://dashboard.stripe.com/settings/billing/portal).
export async function createPortalSession(customerId: string, appUrl: string): Promise<{ url: string }> {
  const s = await stripePost('/billing_portal/sessions', {
    customer: customerId,
    return_url: `${appUrl}/#/account`,
  });
  return { url: s.url };
}

// Verificación de webhook con comparación de tiempo constante. Tolerancia de
// 5 min contra replays. Requiere el body CRUDO (raw bytes) — ver el uso de
// express.raw en el handler.
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, toleranceSec = 300): any | null {
  if (!WEBHOOK_SECRET || !signature) return null;
  const parts: Record<string, string> = {};
  for (const seg of signature.split(',')) {
    const [k, v] = seg.trim().split('=');
    if (k && v) parts[k] = v;
  }
  const tSec = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(tSec) || !v1 || tSec < 0) return null;
  if (Math.abs(Math.floor(Date.now() / 1000) - tSec) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${tSec}.${rawBody.toString('utf8')}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(v1, 'hex');
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
  try { return JSON.parse(rawBody.toString('utf8')); } catch { return null; }
}

import crypto from 'node:crypto';