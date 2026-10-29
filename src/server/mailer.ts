// Envío de emails transaccionales (recuperación de contraseña).
// Dos opciones, la primera que esté configurada:
//  1. Gmail: GMAIL_USER + GMAIL_APP_PASSWORD (contraseña de aplicación de Google). Gratis, manda a cualquier mail.
//  2. Resend: RESEND_API_KEY + EMAIL_FROM (necesita un dominio propio verificado para mandar a cualquiera).
// Si ninguna está configurada, la app funciona igual: el administrador genera los enlaces a mano.
import nodemailer from "nodemailer";

function gmailConfig(): { user: string; pass: string } | null {
  const user = process.env.GMAIL_USER?.trim();
  // Google muestra la contraseña de aplicación en bloques con espacios: se quitan.
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  return user && pass ? { user, pass } : null;
}

export function emailEnabled(): boolean {
  return Boolean(gmailConfig() || (process.env.RESEND_API_KEY && process.env.EMAIL_FROM));
}

export async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  const gmail = gmailConfig();
  if (gmail) {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmail.user, pass: gmail.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await transport.sendMail({
      from: { name: process.env.EMAIL_FROM_NAME?.trim() || "Fiesta de Egresados", address: gmail.user },
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
    return;
  }
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error("Envío de emails no configurado");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}`);
  }
}
