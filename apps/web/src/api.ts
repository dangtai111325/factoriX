import { operatorMessage } from "./format";

export type ApiErrorBody = {
  code?: string;
  message?: string;
  field_errors?: { path: string; code: string }[];
  correlation_id?: string;
  retryable?: boolean;
  retry_after_seconds?: number;
};

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(operatorMessage(body.code));
    this.status = status;
    this.body = body;
  }
}

function csrfToken(): string {
  const row = document.cookie.split("; ").find((item) => item.startsWith("fx_csrf="));
  return row ? decodeURIComponent(row.slice("fx_csrf=".length)) : "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method || "GET").toUpperCase();
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") headers.set("x-csrf-token", csrfToken());
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: ApiErrorBody };
  if (!response.ok) {
    const body = payload.error || { code: "HTTP", message: response.statusText };
    if (response.status === 429) body.retry_after_seconds = Number(response.headers.get("retry-after") || body.retry_after_seconds || 0);
    throw new ApiError(response.status, body);
  }
  return payload as T;
}

export type Me = { admin_id: string; tenant_id: string; login: string; email?: string; locale: string; timezone: string; role: string };
export type AuthStatus = { admin_exists: boolean; bootstrap_enabled: boolean; setup_code_required: boolean; appliance?: boolean };
