import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { registryCtx } from '../../test/helpers/ctx.mjs';
import {
  assertCleanSecrets,
  offerSync,
  readStdin,
  writeAcrossEnvironments,
  writeCell,
} from './set.mjs';

const REGISTRY = {
  shared: [],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['API_URL'],
  admin: [],
};
const CTX = registryCtx(REGISTRY);

const ok = () => ({ status: 0, stdout: '', stderr: '' });

/**
 * A sops double whose document changes once the write has run, so the read-back
 * is exercised rather than trivially satisfied.
 */
function fakeSops({
  initial = { api: { DATABASE_URL: 'old' } },
  result = ok,
} = {}) {
  const calls = [];
  const inputs = [];
  let document = initial;

  return {
    calls,
    decrypt: () => structuredClone(document),
    inputs,
    runSops: (_ctx, args, input) => {
      calls.push(args);
      inputs.push(input);
      const outcome = result(args);
      if (outcome.status === 0) {
        // By pattern, not position: `set` is [set, --value-stdin, file, index]
        // and `unset` is [unset, --idempotent, file, index].
        const index = args.find((arg) => arg.startsWith('["'));
        const [, scope, key] = index.match(/\["(\w+)"\]\["(\w+)"\]/);
        document = { ...document, [scope]: { ...(document[scope] ?? {}) } };
        if (args[0] === 'unset') delete document[scope][key];
        else document[scope][key] = JSON.parse(input);
      }
      return outcome;
    },
  };
}

describe('assertCleanSecrets', () => {
  it('passes when git reports nothing', () => {
    expect(() =>
      assertCleanSecrets(CTX, { runGit: () => ({ status: 0, stdout: '' }) }),
    ).not.toThrow();
  });

  it('lists what is dirty, and says why that blocks the undo', () => {
    const runGit = () => ({
      status: 0,
      stdout: ' M secrets/local.enc.yaml\n',
    });

    expect(() => assertCleanSecrets(CTX, { runGit })).toThrow(
      /secrets\/local\.enc\.yaml[\s\S]*git checkout -- secrets\//,
    );
  });

  // If git cannot answer, the undo cannot be relied on, so this fails rather
  // than assuming the directory is clean.
  it('fails when git cannot answer', () => {
    expect(() =>
      assertCleanSecrets(CTX, {
        runGit: () => ({ error: new Error('no git') }),
      }),
    ).toThrow(/cannot be relied on/);
  });
});

describe('readStdin', () => {
  it('refuses a terminal instead of hanging forever', async () => {
    await expect(readStdin(CTX, { isTTY: true })).rejects.toThrow(
      /Stdin is a terminal/,
    );
  });
});

describe('writeCell', () => {
  const target = {
    environment: 'local',
    scope: 'api',
    key: 'DATABASE_URL',
    value: 'new',
  };

  it('passes the index on argv and the value on stdin, never on argv', () => {
    const sops = fakeSops();

    writeCell(CTX, target, sops);

    expect(sops.calls).toHaveLength(1);
    expect(sops.calls[0]).toEqual([
      'set',
      '--value-stdin',
      expect.stringContaining('local.enc.yaml'),
      '["api"]["DATABASE_URL"]',
    ]);
    expect(sops.inputs[0]).toBe('"new"');
    expect(sops.calls[0].join(' ')).not.toContain('new');
  });

  it('reports what it changed', () => {
    const sops = fakeSops();

    expect(writeCell(CTX, target, sops)).toMatchObject({
      environment: 'local',
      mode: 'set',
      key: 'api.DATABASE_URL',
    });
  });

  // The refusals below must all happen before the process runs. A control that
  // fires after the write is a report, not a gate.
  it('refuses an undeclared key without running sops', () => {
    const sops = fakeSops();

    expect(() => writeCell(CTX, { ...target, key: 'INVENTED' }, sops)).toThrow(
      /not declared for scope "api"/,
    );
    expect(sops.calls).toEqual([]);
  });

  it('refuses a key filed under the wrong scope without running sops', () => {
    const sops = fakeSops();

    expect(() => writeCell(CTX, { ...target, scope: 'web' }, sops)).toThrow(
      /declared for "api"/,
    );
    expect(sops.calls).toEqual([]);
  });

  // Validating the mutated document also refuses to write into one that was
  // already broken by hand.
  it('refuses when the document is already invalid, without running sops', () => {
    const sops = fakeSops({
      initial: { api: { DATABASE_URL: 'old', SMUGGLED: 'x' } },
    });

    expect(() => writeCell(CTX, target, sops)).toThrow(/SMUGGLED/);
    expect(sops.calls).toEqual([]);
  });

  it('maps a missing sops binary to the install hint', () => {
    const sops = fakeSops({
      result: () => ({
        error: Object.assign(new Error('x'), { code: 'ENOENT' }),
      }),
    });

    expect(() => writeCell(CTX, target, sops)).toThrow(
      /was not found on PATH.*winget/s,
    );
  });

  it('surfaces sops stderr on a non-zero exit', () => {
    const sops = fakeSops({
      result: () => ({
        status: 1,
        stdout: '',
        stderr: 'no matching creation rules',
      }),
    });

    expect(() => writeCell(CTX, target, sops)).toThrow(
      /exit code 1[\s\S]*no matching creation rules/,
    );
  });

  // sops reports success for a value it coerced, and a silent type change
  // surfaces much later as a validation failure at boot.
  it('fails when the value does not read back as written', () => {
    const sops = fakeSops();
    const liar = {
      ...sops,
      runSops: (_ctx, args) => {
        sops.calls.push(args);
        return ok();
      },
    };

    expect(() => writeCell(CTX, target, liar)).toThrow(
      /did not return what was written/,
    );
  });

  it('removes a key in unset mode and confirms it is gone', () => {
    const sops = fakeSops();

    const outcome = writeCell(CTX, { ...target, mode: 'unset' }, sops);

    expect(sops.calls[0]).toEqual([
      'unset',
      '--idempotent',
      expect.stringContaining('local.enc.yaml'),
      '["api"]["DATABASE_URL"]',
    ]);
    expect(outcome.mode).toBe('unset');
  });
});

describe('writeAcrossEnvironments', () => {
  const target = { scope: 'api', key: 'DATABASE_URL', value: 'new' };

  it('writes every environment in order', () => {
    const sops = fakeSops();

    const { applied, failed } = writeAcrossEnvironments(
      CTX,
      { ...target, environments: ['local', 'staging'] },
      sops,
    );

    expect(failed).toBeNull();
    expect(applied.map((entry) => entry.environment)).toEqual([
      'local',
      'staging',
    ]);
  });

  // The common failure is holding the local key and not the production one.
  // Catching it after local and staging are written leaves the set half-applied
  // across files with no shared marker to say so.
  it('writes nothing when one target cannot be decrypted', () => {
    const sops = fakeSops();
    const decrypt = (file) => {
      if (String(file).includes('production')) {
        throw new Error('no identity matched any of the recipients');
      }
      return sops.decrypt();
    };

    expect(() =>
      writeAcrossEnvironments(
        CTX,
        { ...target, environments: ['local', 'production'] },
        { ...sops, decrypt },
      ),
    ).toThrow(/Refusing to write anything[\s\S]*production/);
    expect(sops.calls).toEqual([]);
  });

  it('stops at the first failure and says what was already written', () => {
    const sops = fakeSops();
    let writes = 0;
    const runSops = (ctx, args, input) => {
      writes += 1;
      if (writes === 2) return { status: 1, stdout: '', stderr: 'boom' };
      return sops.runSops(ctx, args, input);
    };

    const { applied, failed } = writeAcrossEnvironments(
      CTX,
      { ...target, environments: ['local', 'staging', 'production'] },
      { ...sops, runSops },
    );

    expect(applied.map((entry) => entry.environment)).toEqual(['local']);
    expect(failed.environment).toBe('staging');
    expect(failed.message).toMatch(/boom/);
  });

  it('refuses an undeclared key before decrypting anything', () => {
    const sops = fakeSops();
    const decrypt = () => {
      throw new Error('must not be called');
    };

    expect(() =>
      writeAcrossEnvironments(
        CTX,
        { ...target, key: 'INVENTED', environments: ['local'] },
        { ...sops, decrypt },
      ),
    ).toThrow(/not declared/);
  });
});

describe('offerSync', () => {
  const answering = (text) => {
    const input = new PassThrough();
    input.isTTY = true;
    input.end(text);
    return input;
  };
  const recorder = (status) => {
    const calls = [];
    return {
      calls,
      runSync: async (ctx, argv) => {
        calls.push({ ctx, argv });
        return status;
      },
    };
  };
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  it('dry-runs then syncs each syncable environment, and returns 0', async () => {
    quiet();
    const { calls, runSync } = recorder(0);

    const status = await offerSync(
      CTX,
      { environments: ['local', 'staging', 'production'], scope: 'api' },
      { runSync, input: answering('y\n'), output: new PassThrough() },
    );

    expect(status).toBe(0);
    expect(calls.every((call) => call.ctx === CTX)).toBe(true);
    expect(calls.map((call) => call.argv)).toEqual([
      ['staging', 'api', '--dry-run'],
      ['production', 'api', '--dry-run'],
      ['staging', 'api'],
      ['production', 'api'],
    ]);
  });

  it('propagates a failing sync as a non-zero status and stops', async () => {
    quiet();
    const { calls, runSync } = recorder(1);

    const status = await offerSync(
      CTX,
      { environments: ['staging', 'production'], scope: 'shared' },
      { runSync, input: answering('y\n'), output: new PassThrough() },
    );

    expect(status).toBe(1);
    expect(calls.map((call) => call.argv)).toEqual([
      ['staging', 'all', '--dry-run'],
    ]);
  });

  it('runs no real sync when the answer is no', async () => {
    quiet();
    const { calls, runSync } = recorder(0);

    const status = await offerSync(
      CTX,
      { environments: ['staging', 'production'], scope: 'api' },
      { runSync, input: answering('n\n'), output: new PassThrough() },
    );

    expect(status).toBe(0);
    expect(calls.every((call) => call.argv.includes('--dry-run'))).toBe(true);
  });
});
