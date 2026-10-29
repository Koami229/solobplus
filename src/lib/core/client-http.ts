export function getCsrfTokenFromDocumentCookie(): string {
  if (typeof document === 'undefined' || !document.cookie) {
    return '1';
  }
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('solob_csrf=')) {
      const value = trimmed.slice('solob_csrf='.length).trim();
      if (value) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
  }
  return '1';
}

export async function apiFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const method = (init.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    headers.set('X-Solob-CSRF', getCsrfTokenFromDocumentCookie());
  }

  return fetch(input, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
}
