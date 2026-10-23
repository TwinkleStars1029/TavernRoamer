import type { EnvironmentPort } from '../../environment/EnvironmentPort';
import { getSillyTavernContext, getTavernGlobals } from '../host';
import { isPlainRecord, readOptionalString } from '../helpers';
import { parseEnvironmentSnapshot } from '../../environment/validation';
import { assertEnvironmentContext } from './context';

type PersonaPort = Pick<EnvironmentPort, 'exportPersona' | 'applyPersona'>;

export function createPersonaAdapter(): PersonaPort {
  const globals = getTavernGlobals();
  return {
    async exportPersona() {
      if (typeof globals.getPersona !== 'function') throw new Error('Persona export API is unavailable');
      const data = await globals.getPersona('current');
      if (!isPlainRecord(data)) throw new Error('Persona 資料格式不完整');
      const avatar = data.avatar;
      let image: Blob;
      if (avatar instanceof Blob) {
        image = avatar;
      } else {
        const path = typeof globals.getPersonaAvatarPath === 'function'
          ? globals.getPersonaAvatarPath('current') : null;
        if (typeof path !== 'string' || !path) throw new Error('無法取得 Persona 頭像路徑，備份已中止');
        const response = await fetch(path);
        if (!response.ok) throw new Error(`無法讀取 Persona 頭像：HTTP ${response.status}`);
        image = await response.blob();
      }
      if (!image.type.startsWith('image/') || image.size === 0) {
        throw new Error('Persona 頭像不是有效圖片，備份已中止');
      }
      const bytes = new Uint8Array(await image.arrayBuffer());
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
      }
      const currentName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
      return {
        kind: 'persona', exportedAt: new Date().toISOString(),
        name: readOptionalString((data as Record<string, unknown> | null)?.name) ?? currentName,
        data: { ...data, avatar: typeof avatar === 'string' ? avatar : undefined },
        avatarImage: { mimeType: image.type, base64: btoa(chunks.join('')) }
      };
    },
    async applyPersona(snapshot, contextKey) {
      const validated = parseEnvironmentSnapshot('persona', snapshot);
      assertEnvironmentContext(contextKey);
      const context = getSillyTavernContext();
      const personaApi = globals.createOrReplacePersona ?? context?.createOrReplacePersona;
      if (typeof personaApi !== 'function') throw new Error('Persona restore API is unavailable');
      const data = { ...(validated.data as Record<string, unknown>) };
      if (validated.avatarImage) {
        const binary = atob(validated.avatarImage.base64);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        data.avatar = new Blob([bytes], { type: validated.avatarImage.mimeType });
      }
      await personaApi(validated.name ?? 'Imported Persona', data);
      assertEnvironmentContext(contextKey);
    }
  };
}
