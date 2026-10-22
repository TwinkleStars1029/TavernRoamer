import { getSillyTavernContext } from './host';

export function getRequestHeaders(): Record<string, string> {
  const headers = getSillyTavernContext()?.getRequestHeaders?.();
  if (headers && typeof headers === 'object') {
    return headers as Record<string, string>;
  }
  return { 'Content-Type': 'application/json' };
}

export function postTavernJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify(body),
    cache: 'no-cache'
  });
}
