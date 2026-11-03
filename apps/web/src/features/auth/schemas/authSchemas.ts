const LOGIN_RE = /^[A-Za-z0-9._-]{3,64}$/
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i
const CLASSES = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]

export type FieldErrors = Record<string, string>

export function validateLoginIdentity(value: string): string | null {
  if (!value.trim()) return 'Enter your email or username.'
  return null
}

export function validatePasswordRequired(value: string): string | null {
  if (!value) return 'Enter your password.'
  return null
}

export function validateFullName(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Enter your full name.'
  if (trimmed.length > 120) return 'Full name must be at most 120 characters.'
  return null
}

export function validateEmail(value: string): string | null {
  const cleaned = value.trim().toLowerCase()
  if (!cleaned) return 'Enter your work email.'
  if (cleaned.length > 254 || !EMAIL_RE.test(cleaned)) return 'Enter a valid email address.'
  return null
}

export function validateUsername(value: string): string | null {
  if (!value.trim()) return 'Enter a username.'
  if (!LOGIN_RE.test(value.trim())) return 'Username must be 3–64 characters: letters, numbers, . _ -'
  return null
}

export function passwordChecks(password: string, username: string) {
  const groups = CLASSES.reduce((count, pattern) => count + (pattern.test(password) ? 1 : 0), 0)
  return {
    length: password.length >= 12 && password.length <= 128,
    classes: groups >= 3,
    noUsername: !username || !password.toLowerCase().includes(username.toLowerCase()),
    noEdgeSpace: password === password.trim(),
  }
}

export function validateNewPassword(password: string, username: string): string | null {
  if (!password) return 'Enter a password.'
  const checks = passwordChecks(password, username)
  if (!checks.length) return 'Password must be 12–128 characters.'
  if (!checks.classes) return 'Password needs at least 3 character groups (upper, lower, digit, symbol).'
  if (!checks.noUsername) return 'Password must not contain your username.'
  if (!checks.noEdgeSpace) return 'Password cannot start or end with spaces.'
  return null
}

export function validateConfirmPassword(password: string, confirm: string): string | null {
  if (!confirm) return 'Confirm your password.'
  if (password !== confirm) return 'Passwords do not match.'
  return null
}

export function validateResetCode(code: string): string | null {
  if (!/^\d{6}$/.test(code.trim())) return 'Enter the 6-digit reset code.'
  return null
}
