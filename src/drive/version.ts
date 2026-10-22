import type { DriveItem, DriveVersion } from './DriveClient';

const VERSION_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)__(.+)\.(json|jsonl)$/;

export function createUtcTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export function parseUtcTimestamp(timestamp: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(timestamp)) {
    return null;
  }
  const iso = timestamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/,
    '$1T$2:$3:$4Z'
  );
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildVersionFilename(deviceName: string, date = new Date(), extension: 'json' | 'jsonl' = 'json'): string {
  return `${createUtcTimestamp(date)}__${sanitizeVersionDevice(deviceName)}.${extension}`;
}

type ParsedVersionFilename = Pick<DriveVersion, 'uploadedAt' | 'uploadedAtUtc' | 'device'>;

export function parseVersionFilename(filename: string): ParsedVersionFilename | null {
  const match = VERSION_FILENAME_PATTERN.exec(filename);
  if (!match) {
    return null;
  }
  const uploadedAtUtc = match[1] ?? '';
  const device = match[2] ?? '';
  const uploadedAt = parseUtcTimestamp(uploadedAtUtc);
  if (!uploadedAt) {
    return null;
  }
  return { uploadedAt, uploadedAtUtc, device };
}

export function itemToVersion(item: DriveItem): DriveVersion | null {
  const parsed = parseVersionFilename(item.name);
  if (!parsed) {
    return null;
  }
  const createdAt = parseDriveDate(item.createdAt);
  const updatedAt = parseDriveDate(item.updatedAt);
  return {
    ...parsed,
    fileId: item.id,
    filename: item.name,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

export function sortVersions(versions: DriveVersion[]): DriveVersion[] {
  return [...versions].sort((left, right) => {
    const timeOrder = versionOrderTime(left) - versionOrderTime(right);
    if (timeOrder !== 0) return timeOrder;
    const filenameOrder = left.filename.localeCompare(right.filename);
    return filenameOrder !== 0 ? filenameOrder : left.fileId.localeCompare(right.fileId);
  });
}

function versionOrderTime(version: DriveVersion): number {
  return version.createdAt?.getTime() ?? version.uploadedAt.getTime();
}

function parseDriveDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function formatLocalTime(date: Date, locale: string = defaultLocale(), timeZone?: string): string {
  return formatLocalDateTime(date, locale, timeZone, true);
}

export function formatLocalMinute(date: Date, locale: string = defaultLocale(), timeZone?: string): string {
  return formatLocalDateTime(date, locale, timeZone, false);
}

function formatLocalDateTime(date: Date, locale: string, timeZone: string | undefined, includeSeconds: boolean): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  if (includeSeconds) {
    options.second = '2-digit';
  }
  if (timeZone) {
    options.timeZone = timeZone;
  }
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * 將 last_synced_version 檔名（UTC 時間戳）解析為本地時區字串。
 * 純函式：無效 / 缺值檔名回退 fallback（預設「—」），可指定 locale / timeZone 以利測試。
 */
export function formatLastSyncedLabel(
  filename: string | null | undefined,
  options: { locale?: string; timeZone?: string; fallback?: string } = {}
): string {
  const fallback = options.fallback ?? '—';
  if (typeof filename !== 'string' || filename.length === 0) {
    return fallback;
  }
  const parsed = parseVersionFilename(filename);
  if (!parsed) {
    return fallback;
  }
  return formatLocalTime(parsed.uploadedAt, options.locale ?? defaultLocale(), options.timeZone);
}

function defaultLocale(): string {
  try {
    return (globalThis as { navigator?: { language?: string } }).navigator?.language ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

function sanitizeVersionDevice(deviceName: string): string {
  return [...deviceName]
    .map(char => (isUnsafeFilenameChar(char) ? '_' : char))
    .join('')
    .trim() || 'unknown-device';
}

function isUnsafeFilenameChar(char: string): boolean {
  return '\\/:*?"<>|#'.includes(char) || char.charCodeAt(0) < 32;
}
