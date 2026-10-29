import { NextResponse, type NextRequest } from "next/server";

// Renueva las cookies de sesión en cada visita: mientras la persona entre, la sesión no vence
// (la base también la extiende al validarla). Mismos nombres que src/lib/session.ts.
const PROD = process.env.NODE_ENV === "production";
const COOKIES = PROD ? ["__Host-fde_session", "__Host-fde_session_2"] : ["fde_session", "fde_session_2"];
const MAX_AGE = 90 * 24 * 3600;

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  // Solo en visitas (GET). Los POST son acciones (ingresar, salir, cambiar de cuenta) que manejan
  // sus propias cookies: renovar acá la vieja podría pisar lo que hace la acción.
  if (request.method !== "GET") return response;
  for (const name of COOKIES) {
    const value = request.cookies.get(name)?.value;
    if (value && value.length <= 200) {
      response.cookies.set(name, value, { httpOnly: true, secure: PROD, sameSite: "lax", path: "/", maxAge: MAX_AGE });
    }
  }
  return response;
}

export const config = {
  // Solo páginas: no archivos estáticos ni la API.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt|xml)$).*)"],
};
