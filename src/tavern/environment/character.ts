import type { EnvironmentPort } from '../../environment/EnvironmentPort';
import { getTavernGlobals } from '../host';
import { isPlainRecord } from '../helpers';
import { parseEnvironmentSnapshot } from '../../environment/validation';
import { assertEnvironmentContext } from './context';

type CharacterPort = Pick<EnvironmentPort, 'exportCharacter' | 'applyCharacter'>;

export function createCharacterAdapter(): CharacterPort {
  const globals = getTavernGlobals();
  return {
    async exportCharacter() {
      if (typeof globals.getCharacter !== 'function') throw new Error('Character export API is unavailable');
      const data = await globals.getCharacter('current');
      if (!isPlainRecord(data)) throw new Error('角色卡資料格式不完整');
      const avatar = data.avatar;
      let image: Blob;
      if (avatar instanceof Blob) {
        image = avatar;
      } else {
        const path = typeof globals.getCharAvatarPath === 'function'
          ? globals.getCharAvatarPath('current') : null;
        if (typeof path !== 'string' || !path) throw new Error('無法取得角色卡頭像路徑，備份已中止');
        const response = await fetch(path);
        if (!response.ok) throw new Error(`無法讀取角色卡頭像：HTTP ${response.status}`);
        image = await response.blob();
      }
      if (!image.type.startsWith('image/') || image.size === 0) {
        throw new Error('角色卡頭像不是有效圖片，備份已中止');
      }
      const bytes = new Uint8Array(await image.arrayBuffer());
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
      }
      const characterName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
      return {
        kind: 'character', exportedAt: new Date().toISOString(), characterName,
        data: { ...data, avatar: typeof avatar === 'string' ? avatar : undefined },
        avatarImage: { mimeType: image.type, base64: btoa(chunks.join('')) }
      };
    },
    async applyCharacter(snapshot, contextKey) {
      const validated = parseEnvironmentSnapshot('character', snapshot);
      assertEnvironmentContext(contextKey);
      if (typeof globals.createOrReplaceCharacter !== 'function') throw new Error('Character restore API is unavailable');
      const currentName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
      const data = { ...(validated.data as Record<string, unknown>) };
      if (validated.avatarImage) {
        const binary = atob(validated.avatarImage.base64);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        data.avatar = new Blob([bytes], { type: validated.avatarImage.mimeType });
      }
      await globals.createOrReplaceCharacter(validated.characterName ?? currentName ?? 'Imported Character', data, { render: 'none' });
      assertEnvironmentContext(contextKey);
    }
  };
}
