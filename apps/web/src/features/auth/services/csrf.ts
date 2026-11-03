export function readCookie(name: string): string | null {
  const part = document.cookie.split('; ').find((item) => item.startsWith(`${name}=`))
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null
}
