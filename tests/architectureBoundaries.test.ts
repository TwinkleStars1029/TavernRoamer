import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');

describe('architecture boundaries', () => {
  it('keeps the public UI and Tavern modules as thin compatibility facades', () => {
    expect(lineCount(join(SOURCE_ROOT, 'ui.ts'))).toBeLessThanOrEqual(50);
    expect(lineCount(join(SOURCE_ROOT, 'tavern.ts'))).toBeLessThanOrEqual(50);
  });

  it('keeps UI modules independent from persistence, diagnostics, application services and Tavern adapters', () => {
    const forbidden = [
      /from\s+['"][^'"]*settings['"];/,
      /from\s+['"][^'"]*selfCheck['"];/,
      /from\s+['"][^'"]*tavern(?:\/[^'"]*)?['"];/,
      /from\s+['"][^'"]*(?:ChatSyncService|ChatPullService|EnvironmentBackupService|EnvironmentRestoreService)['"];/,
      /from\s+['"][^'"]*(?:DriveClient|DriveService|GoogleDriveClient)['"];/
    ];
    for (const file of listTypeScriptFiles(join(SOURCE_ROOT, 'ui'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) expect(source, `${file} imports a forbidden dependency`).not.toMatch(pattern);
    }
  });

  it('keeps feature services independent from concrete Tavern modules', () => {
    for (const directory of ['chat', 'environment']) {
      for (const file of listTypeScriptFiles(join(SOURCE_ROOT, directory))) {
        expect(readFileSync(file, 'utf8'), `${file} imports the Tavern implementation`).not.toMatch(
          /from\s+['"][^'"]*tavern(?:\/[^'"]*)?['"];/
        );
      }
    }
  });
});

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').split(/\r?\n/).length;
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}
