export const CHAT_CONTENT_HASH_VERSION = 1;

export type ChatContentSnapshot = Readonly<{
  canonicalContent: string;
  contentHash: string;
  hashVersion: typeof CHAT_CONTENT_HASH_VERSION;
  messageCount: number;
}>;

export async function createChatContentSnapshot(content: string): Promise<ChatContentSnapshot> {
  const parsed = parseRawChatContent(content);
  const canonicalContent = parsed.rows.map(row => stableStringify(stripSyncBookkeeping(row))).join('\n');
  const contentHash = await sha256(canonicalContent);
  return {
    canonicalContent,
    contentHash,
    hashVersion: CHAT_CONTENT_HASH_VERSION,
    messageCount: parsed.messageCount
  };
}

export function parseRawChatContent(content: string): {
  rows: Array<Record<string, unknown>>;
  messageCount: number;
} {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('聊天 JSONL 為空或不是字串');
  }
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  const rows = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`聊天 JSONL 第 ${index + 1} 行無法解析`);
    }
    if (!isRecord(parsed)) throw new Error(`聊天 JSONL 第 ${index + 1} 行必須是物件`);
    return parsed;
  });
  const header = rows[0];
  if (!header || !isHeader(header)) throw new Error('聊天 JSONL 缺少合法 header');
  for (let index = 1; index < rows.length; index += 1) {
    if (!isMessage(rows[index]!)) throw new Error(`聊天 JSONL 第 ${index + 1} 行不是支援的訊息物件`);
  }
  return { rows, messageCount: Math.max(0, rows.length - 1) };
}

function isHeader(row: Record<string, unknown>): boolean {
  return row.chat_metadata !== undefined || typeof row.user_name === 'string' || typeof row.name === 'string';
}

function isMessage(row: Record<string, unknown>): boolean {
  return (
    typeof row.mes === 'string' ||
    typeof row.message === 'string' ||
    typeof row.name === 'string' ||
    row.is_user === true ||
    row.is_system === true ||
    row.role === 'user' ||
    row.role === 'assistant' ||
    row.role === 'system'
  );
}

function stripSyncBookkeeping(row: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneJson(row) as Record<string, unknown>;
  delete cloned._drive_sync;
  for (const container of [cloned.variables, cloned.chat_variables]) removeSyncKey(container);
  if (isRecord(cloned.chat_metadata)) {
    delete cloned.chat_metadata._drive_sync;
    removeSyncKey(cloned.chat_metadata.variables);
    removeSyncKey(cloned.chat_metadata.chat_variables);
  }
  return cloned;
}

function removeSyncKey(value: unknown): void {
  if (isRecord(value)) delete value._drive_sync;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('目前環境不支援 SHA-256，無法安全核對聊天內容');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
