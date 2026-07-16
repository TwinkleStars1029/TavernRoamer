const DRIVE_CONFUSING_CHARS = '\\/:*?"<>|#';

export function sanitizeRoleKey(value: string, fallback = '未命名角色'): string {
  const normalized = value
    .normalize('NFKC')
    .split('')
    .map(char => (isUnsafeRoleKeyChar(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || fallback;
}

function isUnsafeRoleKeyChar(char: string): boolean {
  return DRIVE_CONFUSING_CHARS.includes(char) || char.charCodeAt(0) < 32;
}
