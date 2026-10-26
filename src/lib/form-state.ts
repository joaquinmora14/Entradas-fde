export interface FormState {
  ok: boolean;
  message: string;
  fields?: Record<string, string>;
  data?: unknown;
}

export const initialFormState: FormState = { ok: false, message: "" };
