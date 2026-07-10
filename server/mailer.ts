import nodemailer from 'nodemailer';

// SMTP_URL: smtps://usuario:clave@host:465 (o smtp:// con STARTTLS en 587).
// Sin configurar, los correos se registran en consola — útil en desarrollo.
const smtpUrl = process.env.SMTP_URL;
const FROM = process.env.MAIL_FROM ?? 'QuarryHQ <no-reply@quarryhq.pro>';

export const APP_URL = process.env.APP_URL
  ?? (process.env.NODE_ENV === 'production' ? 'https://quarryhq.pro' : 'http://localhost:5173');

const transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;

export async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  if (!transport) {
    console.log(`[correo sin SMTP_URL] Para: ${to} — ${subject}\n${html}`);
    return false;
  }
  try {
    await transport.sendMail({ from: FROM, to, subject, html });
    return true;
  } catch (err) {
    console.error(`Error enviando correo a ${to}:`, err);
    return false;
  }
}

const layout = (title: string, body: string, cta: { url: string; label: string }) => `
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;font-family:system-ui,sans-serif;color:#1a1d29">
    <div style="font-size:20px;font-weight:800;margin-bottom:16px">⚡ QuarryHQ</div>
    <h2 style="font-size:17px;margin:0 0 12px">${title}</h2>
    <div style="font-size:14px;line-height:1.6;color:#3c4257">${body}</div>
    <a href="${cta.url}" style="display:inline-block;margin:20px 0;padding:10px 22px;background:#5b64e8;color:#fff;
       text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">${cta.label}</a>
    <p style="font-size:12px;color:#8891a7">Si el botón no funciona, copia este enlace:<br>${cta.url}</p>
    <p style="font-size:12px;color:#8891a7">Si no solicitaste esto, ignora este correo.</p>
  </div>`;

export function verifyEmailHtml(token: string): string {
  const url = `${APP_URL}/api/auth/verify?token=${token}`;
  return layout('Confirma tu correo',
    'Gracias por crear tu cuenta en QuarryHQ. Confirma tu dirección de correo para poder recuperar tu cuenta si olvidas la contraseña.',
    { url, label: 'Confirmar correo' });
}

export function resetPasswordHtml(token: string): string {
  const url = `${APP_URL}/#/reset/${token}`;
  return layout('Restablece tu contraseña',
    'Recibimos un pedido para restablecer tu contraseña de QuarryHQ. El enlace vence en 1 hora y solo puede usarse una vez.',
    { url, label: 'Elegir nueva contraseña' });
}
