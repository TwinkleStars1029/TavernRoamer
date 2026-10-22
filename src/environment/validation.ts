import type {
  CharacterSnapshot,
  EnvironmentItemKind,
  EnvironmentSnapshot,
  PersonaSnapshot,
  PresetSnapshot,
  RegexSnapshot,
  WorldBindingsSnapshot,
  WorldSnapshot
} from './types';

export class SnapshotValidationError extends Error {
  readonly code: 'invalid_snapshot' | 'unsupported_schema_version' | 'unsupported_format';

  constructor(
    code: SnapshotValidationError['code'],
    readonly path: string,
    message: string
  ) {
    super(`${message}（${path}）`);
    this.name = 'SnapshotValidationError';
    this.code = code;
  }
}

export type EnvironmentSnapshotFor<K extends EnvironmentItemKind> = Extract<EnvironmentSnapshot, { kind: K }>;

export function parseEnvironmentSnapshot<K extends EnvironmentItemKind>(
  expectedKind: K,
  value: unknown
): EnvironmentSnapshotFor<K> {
  const root = expectRecord(value, '$');
  if (root.kind !== expectedKind) {
    invalid('$.kind', `環境備份類型應為 ${expectedKind}`);
  }
  validateSchemaVersion(root.schemaVersion);
  validateExportedAt(root.exportedAt);

  let snapshot: EnvironmentSnapshot;
  if (expectedKind === 'character') snapshot = parseCharacter(root);
  else if (expectedKind === 'world') snapshot = parseWorld(root);
  else if (expectedKind === 'persona') snapshot = parsePersona(root);
  else if (expectedKind === 'preset') snapshot = parsePreset(root);
  else snapshot = parseRegex(root);
  return snapshot as EnvironmentSnapshotFor<K>;
}

function parseCharacter(root: Record<string, unknown>): CharacterSnapshot {
  const data = expectRecord(root.data, '$.data');
  const characterName = readName(root.characterName) ?? readName(data.name);
  if (!characterName) invalid('$.characterName', '角色卡備份缺少可辨識的角色名稱');
  validateAvatarImage(root.avatarImage, '角色卡');
  return { ...root, schemaVersion: 1, kind: 'character', exportedAt: root.exportedAt as string, characterName, data } as CharacterSnapshot;
}

function parsePersona(root: Record<string, unknown>): PersonaSnapshot {
  const data = expectRecord(root.data, '$.data');
  const name = readName(root.name) ?? readName(data.name);
  if (!name) invalid('$.name', 'Persona 備份缺少可辨識的名稱');
  validateAvatarImage(root.avatarImage, 'Persona');
  return { ...root, schemaVersion: 1, kind: 'persona', exportedAt: root.exportedAt as string, name, data } as PersonaSnapshot;
}

function validateAvatarImage(value: unknown, subject: string): void {
  if (value === undefined) return;
  const image = expectRecord(value, '$.avatarImage');
  if (typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/')) {
    invalid('$.avatarImage.mimeType', `${subject} 頭像類型不是圖片`);
  }
  if (typeof image.base64 !== 'string' || !image.base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
    invalid('$.avatarImage.base64', `${subject} 頭像內容不是有效的 Base64`);
  }
}

function parseWorld(root: Record<string, unknown>): WorldSnapshot {
  const bindings = parseBindings(root.bindings);
  const books = expectRecord(root.books, '$.books');
  const format = parseWorldFormat(root.format, books);
  for (const [name, book] of Object.entries(books)) {
    if (!name.trim()) invalid('$.books', '世界書名稱不可為空');
    if (format === 'sillytavern-worldinfo-v1') validateRawWorldbook(book, `$.books.${name}`);
    else validateHelperWorldbook(book, `$.books.${name}`);
  }
  for (const name of [bindings.chat, bindings.char_primary, ...bindings.char_additional, ...bindings.global_enabled]) {
    if (name && !Object.hasOwn(books, name)) invalid('$.books', `世界書綁定「${name}」缺少對應內容`);
  }
  return {
    ...root,
    schemaVersion: 1,
    kind: 'world',
    exportedAt: root.exportedAt as string,
    format,
    bindings,
    books
  } as WorldSnapshot;
}

function parsePreset(root: Record<string, unknown>): PresetSnapshot {
  const name = readName(root.name);
  if (!name) invalid('$.name', 'Preset 備份缺少名稱');
  const data = expectRecord(root.data, '$.data');
  const format = parsePresetFormat(root.format, data);
  if (format === 'sillytavern-openai-preset-v1') {
    expectArray(data.prompts, '$.data.prompts').forEach((item, index) => expectRecord(item, `$.data.prompts[${index}]`));
    expectArray(data.prompt_order, '$.data.prompt_order').forEach((item, index) => expectRecord(item, `$.data.prompt_order[${index}]`));
    expectRecord(data.extensions, '$.data.extensions');
  } else if (format === 'tavern-helper-preset-v1') {
    expectRecord(data.settings, '$.data.settings');
    expectArray(data.prompts, '$.data.prompts').forEach((item, index) => expectRecord(item, `$.data.prompts[${index}]`));
    expectArray(data.prompts_unused, '$.data.prompts_unused').forEach((item, index) => expectRecord(item, `$.data.prompts_unused[${index}]`));
    expectRecord(data.extensions, '$.data.extensions');
  }
  return {
    ...root,
    schemaVersion: 1,
    kind: 'preset',
    exportedAt: root.exportedAt as string,
    format,
    name,
    data
  } as PresetSnapshot;
}

function parseRegex(root: Record<string, unknown>): RegexSnapshot {
  if (root.scope !== 'global') invalid('$.scope', 'Regex 備份 scope 必須為 global');
  const items = expectArray(root.items, '$.items');
  items.forEach((item, index) => validateRegexItem(item, `$.items[${index}]`));
  return {
    ...root,
    schemaVersion: 1,
    kind: 'regex',
    exportedAt: root.exportedAt as string,
    scope: 'global',
    items
  } as RegexSnapshot;
}

function validateSchemaVersion(version: unknown): void {
  if (version === undefined || version === 1) return;
  throw new SnapshotValidationError('unsupported_schema_version', '$.schemaVersion', `不支援的環境備份版本：${String(version)}`);
}

function validateExportedAt(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    invalid('$.exportedAt', '環境備份 exportedAt 不是有效日期時間');
  }
}

function parseBindings(value: unknown): WorldBindingsSnapshot {
  const bindings = expectRecord(value, '$.bindings');
  return {
    chat: readNullableString(bindings.chat, '$.bindings.chat'),
    char_primary: readNullableString(bindings.char_primary, '$.bindings.char_primary'),
    char_additional: readStringArray(bindings.char_additional, '$.bindings.char_additional'),
    global_enabled: readStringArray(bindings.global_enabled, '$.bindings.global_enabled')
  };
}

function parseWorldFormat(value: unknown, books: Record<string, unknown>): NonNullable<WorldSnapshot['format']> {
  if (value === 'sillytavern-worldinfo-v1' || value === 'tavern-helper-worldbook-v1') return value;
  if (value !== undefined) unsupportedFormat('$.format', value);
  const contents = Object.values(books);
  if (contents.every(Array.isArray)) return 'tavern-helper-worldbook-v1';
  if (contents.every(book => isRecord(book) && isRecord(book.entries))) return 'sillytavern-worldinfo-v1';
  unsupportedFormat('$.format', value);
}

function parsePresetFormat(value: unknown, data: Record<string, unknown>): NonNullable<PresetSnapshot['format']> {
  if (
    value === 'sillytavern-openai-preset-v1' ||
    value === 'sillytavern-textgenerationwebui-preset-v1' ||
    value === 'tavern-helper-preset-v1'
  ) return value;
  if (value !== undefined) unsupportedFormat('$.format', value);
  if (isRecord(data.settings) && Array.isArray(data.prompts) && Array.isArray(data.prompts_unused) && isRecord(data.extensions)) {
    return 'tavern-helper-preset-v1';
  }
  return 'sillytavern-textgenerationwebui-preset-v1';
}

function validateRawWorldbook(value: unknown, path: string): void {
  const book = expectRecord(value, path);
  const entries = expectRecord(book.entries, `${path}.entries`);
  for (const [key, entry] of Object.entries(entries)) expectRecord(entry, `${path}.entries.${key}`);
}

function validateHelperWorldbook(value: unknown, path: string): void {
  expectArray(value, path).forEach((entry, index) => expectRecord(entry, `${path}[${index}]`));
}

function validateRegexItem(value: unknown, path: string): void {
  const item = expectRecord(value, path);
  const hasIdentity = [item.id, item.scriptName, item.name].some(entry =>
    (typeof entry === 'string' && entry.trim().length > 0) || typeof entry === 'number'
  );
  if (!hasIdentity) invalid(path, 'Regex 規則缺少 id、scriptName 或 name');
  for (const key of ['findRegex', 'replaceString', 'regex', 'replacement']) {
    if (item[key] !== undefined && typeof item[key] !== 'string') invalid(`${path}.${key}`, `Regex ${key} 必須是字串`);
  }
}

function readName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') invalid(path, '欄位必須為字串或 null');
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  const items = expectArray(value, path);
  if (!items.every(item => typeof item === 'string')) invalid(path, '欄位必須是字串陣列');
  return items as string[];
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, '欄位必須是 JSON 物件');
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, '欄位必須是陣列');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): never {
  throw new SnapshotValidationError('invalid_snapshot', path, message);
}

function unsupportedFormat(path: string, value: unknown): never {
  throw new SnapshotValidationError('unsupported_format', path, `不支援的備份格式：${String(value)}`);
}
