import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSelfCheck, runSelfChecks } from '../src/selfCheck';

describe('self check registry', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('collects pass and fail results without aborting the run', async () => {
    registerSelfCheck({
      id: 'unit.pass',
      label: 'pass case',
      async run() {
        return { status: 'pass', message: 'ok' };
      }
    });
    registerSelfCheck({
      id: 'unit.fail',
      label: 'fail case',
      async run() {
        throw new Error('boom');
      }
    });

    const results = await runSelfChecks();

    expect(results.some(result => result.id === 'unit.pass' && result.status === 'pass')).toBe(true);
    expect(results.some(result => result.id === 'unit.fail' && result.status === 'fail')).toBe(true);
  });
});
