"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { buttonClass, cx } from "./ui";

export function SubmitButton({
  children,
  pendingText,
  className,
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  pendingText?: string;
  className?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending || disabled} className={cx(className ?? buttonClass)} aria-busy={pending}>
      {pending ? (
        <>
          <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          {pendingText ?? "Procesando…"}
        </>
      ) : (
        children
      )}
    </button>
  );
}
