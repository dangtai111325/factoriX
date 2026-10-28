/**
 * FactoriX IIoT Platform - HTTP API Client
 * Automatic CSRF injection, session management, and structured error handling.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  fieldErrors?: Record<string, string>;
  retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, fieldErrors?: Record<string, string>, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)fx_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function request<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});

  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  // Inject CSRF token for mutating requests
  if (["POST", "PATCH", "DELETE", "PUT"].includes(method)) {
    const csrf = getCsrfToken();
    if (csrf) {
      headers.set("X-CSRF-Token", csrf);
    }
    if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  if (response.status === 204) {
    return {} as T;
  }

  const contentType = response.headers.get("content-type") || "";
  let data: any = null;
  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const code = data?.code || `HTTP_${response.status}`;
    const message = data?.message || response.statusText || "Đã xảy ra lỗi khi kết nối máy chủ.";
    const fieldErrors = data?.field_errors;
    const retryAfter = data?.retry_after_seconds;
    throw new ApiError(response.status, code, message, fieldErrors, retryAfter);
  }

  return data as T;
}

export const api = {
  get: <T = any>(path: string, headers?: HeadersInit) =>
    request<T>(path, { method: "GET", headers }),

  post: <T = any>(path: string, body?: any, headers?: HeadersInit) =>
    request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
    }),

  patch: <T = any>(path: string, body?: any, headers?: HeadersInit) =>
    request<T>(path, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
    }),

  delete: <T = any>(path: string, headers?: HeadersInit) =>
    request<T>(path, { method: "DELETE", headers }),
};
