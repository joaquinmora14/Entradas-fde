// Envío de emails transaccionales (opcional) mediante la API HTTP de Resend.
// Si RESEND_API_KEY / EMAIL_FROM no están configuradas, la app funciona igual:
// la recuperación de acceso se hace con enlaces generados por el administrador.

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  if (!emailEnabled()) throw new Error("Envío de emails no configurado");
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
