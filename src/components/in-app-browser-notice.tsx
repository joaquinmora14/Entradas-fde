"use client";

import { useSyncExternalStore } from "react";
import { CopyButton } from "./copy-button";

// Navegadores internos de WhatsApp, Instagram, Facebook, TikTok, etc.: al cerrarlos se pierde la sesión.
const IN_APP = /WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|musical_ly|Snapchat|Twitter|LinkedInApp/i;

const subscribe = () => () => {};
const getUserAgent = () => navigator.userAgent;
const getServerUserAgent = () => "";

/** Aviso: si se abrió el link desde WhatsApp/Instagram, conviene abrirlo en Chrome o Safari para que quede la sesión. */
export function InAppBrowserNotice() {
  const ua = useSyncExternalStore(subscribe, getUserAgent, getServerUserAgent);
  if (!ua || !IN_APP.test(ua)) return null;
  const android = /Android/i.test(ua);
  const url = typeof window !== "undefined" ? window.location.href : "";
  const chromeIntent = url ? `intent://${url.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end` : "";
  return (
    <div role="status" className="mb-4 rounded-2xl border-2 border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-bold">Abrilo en {android ? "Chrome" : "Safari"} para que no tengas que ingresar cada vez</p>
      <p className="mt-1">
        Lo abriste desde otra app (WhatsApp, Instagram…) y ese navegador no guarda la sesión.{" "}
        {android ? "Tocá el botón de abajo" : "Tocá los tres puntos (···) o el ícono de compartir y elegí “Abrir en Safari”"}, o copiá el link y pegalo
        en tu navegador.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {android && chromeIntent ? (
          <a href={chromeIntent} className="inline-flex items-center rounded-lg bg-amber-600 px-3 py-2 font-semibold text-white no-underline hover:bg-amber-700">
            Abrir en Chrome
          </a>
        ) : null}
        <CopyButton text={url} label="Copiar link" className="px-3 py-2 text-sm" />
      </div>
    </div>
  );
}
