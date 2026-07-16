import { describe, expect, it } from 'vitest';
import { sanitizeRoleKey } from '../src/roleKey';

describe('sanitizeRoleKey', () => {
  it('keeps Chinese text and removes confusing path characters', () => {
    expect(sanitizeRoleKey('佐助/測試:角色')).toBe('佐助 測試 角色');
  });

  it('falls back when every character is illegal or blank', () => {
    expect(sanitizeRoleKey('////', '角色')).toBe('角色');
    expect(sanitizeRoleKey('   ', '角色')).toBe('角色');
  });
});
