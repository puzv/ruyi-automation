export const AUTH_EVENTS = {
  unauthenticated: 'auth:unauthenticated',
  passwordChangeRequired: 'auth:password-change-required',
}

export async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers)
  let body = options.body
  if (body != null && !(body instanceof FormData) && typeof body !== 'string'
    && !(body instanceof Blob) && !(body instanceof URLSearchParams) && !(body instanceof ArrayBuffer)) {
    body = JSON.stringify(body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  } else if (typeof body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(url, { ...options, body, headers, credentials: 'same-origin' })
  if (response.status === 401 || response.status === 403) {
    const data = await response.clone().json().catch(() => ({}))
    if (response.status === 401 && data.code === 'UNAUTHENTICATED') {
      window.dispatchEvent(new Event(AUTH_EVENTS.unauthenticated))
    } else if (response.status === 403 && data.code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event(AUTH_EVENTS.passwordChangeRequired))
    }
  }
  return response
}

export async function requestJson(url, options) {
  let response
  try { response = await apiFetch(url, options) } catch { throw new Error('无法连接服务，请稍后重试') }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.message || '请求失败，请稍后重试')
  return data
}
