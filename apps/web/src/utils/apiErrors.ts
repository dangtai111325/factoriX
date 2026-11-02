/** Map known Vietnamese API error messages to English for UI display. */
const VI_TO_EN: Record<string, string> = {
  'Không thể đặt loại này bên dưới cha đã chọn.':
    'This resource type cannot be placed under the selected parent.',
  'Mã tài nguyên đã tồn tại.': 'A resource with this code already exists.',
  'Layout đã được chỉnh sửa ở nơi khác.':
    'Layout was modified elsewhere. Reload and try again.',
  'Hãy lưu trữ các tài nguyên con trước.':
    'Archive child resources first.',
  'Mã site đã tồn tại.': 'A site with this code already exists.',
  'Mã tài nguyên không hợp lệ.': 'Resource code is invalid.',
  'Không thể gắn tài nguyên vào chính nó.':
    'A resource cannot be attached to itself.',
  'Tài nguyên đã được chỉnh sửa ở nơi khác.':
    'Resource was modified elsewhere. Reload and try again.',
  'Đăng nhập đang bị tạm khóa.': 'Login is temporarily locked.',
}

/**
 * Translate a known Vietnamese API error (or Error) into English for display.
 * Unknown messages pass through unchanged.
 */
export function translateApiError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.'
  const trimmed = raw.trim()
  return VI_TO_EN[trimmed] ?? trimmed
}
