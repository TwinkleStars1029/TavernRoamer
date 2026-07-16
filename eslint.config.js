import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        getVariables: 'readonly',
        insertOrAssignVariables: 'readonly',
        getScriptId: 'readonly',
        getCurrentCharacterName: 'readonly',
        getCurrentCharacterId: 'readonly',
        getLastMessageId: 'readonly',
        getChatMessages: 'readonly',
        getCharacter: 'readonly',
        createOrReplaceCharacter: 'readonly',
        importRawChat: 'readonly',
        getPreset: 'readonly',
        getTavernRegexes: 'readonly',
        eventOn: 'readonly',
        tavern_events: 'readonly',
        toastr: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
);
