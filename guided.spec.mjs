import { describe, expect, it } from 'vitest';

import { keyLabel, presenceByKey, runGuided, scopeLabel } from './guided.mjs';
import { MARKS } from './list.mjs';

const REGISTRY = {
  shared: [],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['TRIPGENCY_API_URL'],
  admin: [],
};

const DECLARATIONS = {
  api: {
    DATABASE_URL: { presence: 'required', defaultLiteral: null },
    LOG_LEVEL: { presence: 'default', defaultLiteral: "'info'" },
  },
  web: { TRIPGENCY_API_URL: { presence: 'required', defaultLiteral: null } },
  admin: {},
};

const inventory = (scopes) =>
  Object.fromEntries(
    Object.entries(scopes).map(([scope, keys]) => [
      scope,
      {
        keys: Object.fromEntries(keys.map((key) => [key, { encrypted: true }])),
      },
    ]),
  );

const INVENTORIES = {
  local: inventory({ api: ['DATABASE_URL', 'LOG_LEVEL'], web: [] }),
  staging: inventory({ api: ['DATABASE_URL'], web: [] }),
};

const ENVS = ['local', 'staging'];

/** Collects what the form printed, so the preview can be asserted. */
function fakeOutput() {
  const lines = [];
  return {
    lines,
    write: (chunk) => {
      lines.push(String(chunk).replace(/\n$/, ''));
      return true;
    },
    get text() {
      return lines.join('\n');
    },
  };
}

/** Answers in order, and a record of the questions asked. */
function scripted(answers) {
  const asked = [];
  let index = 0;

  return {
    asked,
    choose: (question, parse) => {
      asked.push(question);
      return Promise.resolve(parse(answers[index++]));
    },
  };
}

const base = (answers, extra = {}) => {
  const output = fakeOutput();
  const script = scripted(answers);

  return {
    output,
    script,
    options: {
      environments: ENVS,
      registry: REGISTRY,
      output,
      readInventory: (environment) => INVENTORIES[environment],
      loadDeclarations: () => DECLARATIONS,
      choose: script.choose,
      readValue: () => Promise.resolve('a-value'),
      confirm: () => Promise.resolve(true),
      ...extra,
    },
  };
};

describe('presenceByKey', () => {
  it('says which environments hold each declared key', () => {
    expect(
      presenceByKey('api', INVENTORIES, {
        environments: ENVS,
        registry: REGISTRY,
      }),
    ).toEqual({
      DATABASE_URL: { local: true, staging: true },
      LOG_LEVEL: { local: true, staging: false },
    });
  });

  it('covers a declared key no environment holds', () => {
    expect(
      presenceByKey('web', INVENTORIES, {
        environments: ENVS,
        registry: REGISTRY,
      }),
    ).toEqual({ TRIPGENCY_API_URL: { local: false, staging: false } });
  });
});

describe('keyLabel', () => {
  // The schema marker is the difference between "a bug" and "nobody needs it
  // yet", so it belongs on the row you pick from, not two screens away.
  it('carries the schema marker and one cell per environment', () => {
    const label = keyLabel(
      'LOG_LEVEL',
      { local: true, staging: false },
      DECLARATIONS.api.LOG_LEVEL,
      { environments: ENVS },
    );

    expect(label).toContain('LOG_LEVEL');
    expect(label).toContain("def('info')");
    expect(label.trimEnd().endsWith(`${MARKS.set}${MARKS.unset}`)).toBe(true);
  });
});

describe('scopeLabel', () => {
  it('counts what is declared and what is set somewhere, and names the apps', () => {
    const label = scopeLabel('api', INVENTORIES, {
      environments: ENVS,
      registry: REGISTRY,
    });

    expect(label).toMatch(/2 declared/);
    expect(label).toMatch(/2 set somewhere/);
    expect(label).toContain('api');
  });

  it('reports a scope nothing is set in as zero', () => {
    expect(
      scopeLabel('web', INVENTORIES, {
        environments: ENVS,
        registry: REGISTRY,
      }),
    ).toMatch(/0 set somewhere/);
  });
});

describe('runGuided', () => {
  it('walks scope, key, environments and returns the write', async () => {
    const { options } = base(['1', '2', '1']);

    expect(await runGuided(options)).toEqual({
      scope: 'api',
      key: 'LOG_LEVEL',
      environments: ['local'],
      values: { local: 'a-value' },
    });
  });

  it('asks once per chosen environment', async () => {
    const prompts = [];
    const { options } = base(['1', '1', 'all'], {
      readValue: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(`value-${prompts.length}`);
      },
    });

    const result = await runGuided(options);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('local');
    expect(prompts[1]).toContain('staging');
    // Distinct values, which is the whole reason it asks twice: never reuse a
    // staging key in production.
    expect(result.values).toEqual({ local: 'value-1', staging: 'value-2' });
  });

  it('offers only the scopes the registry actually declares keys for', async () => {
    const { options, output } = base(['1', '1', '1']);

    await runGuided(options);

    // `shared` and `admin` are empty in this registry, so listing them would
    // offer a menu entry that leads nowhere.
    expect(output.text).toContain('api');
    expect(output.text).toContain('web');
    expect(output.text).not.toMatch(/^\s+\d\) shared/m);
  });

  it('previews what will change without printing a value', async () => {
    const { options, output } = base(['1', '1', '1'], {
      readValue: () => Promise.resolve('super-secret-value'),
    });

    await runGuided(options);

    expect(output.text).toContain('about to write');
    expect(output.text).toContain('api.DATABASE_URL');
    expect(output.text).toContain('secrets/local.enc.yaml');
    expect(output.text).not.toContain('super-secret-value');
  });

  it('says which environments it is leaving alone', async () => {
    const { options, output } = base(['1', '1', '1']);

    await runGuided(options);

    expect(output.text).toContain('staging left alone');
  });

  it('returns null and writes nothing when the answer is not yes', async () => {
    const { options, output } = base(['1', '1', '1'], {
      confirm: () => Promise.resolve(false),
    });

    expect(await runGuided(options)).toBeNull();
    expect(output.text).toContain('Nothing was written');
  });

  // An empty value and an unset variable mean different things to the schemas,
  // and several treat '' as absent.
  it('refuses an empty value rather than guessing which was meant', async () => {
    const { options } = base(['1', '1', '1'], {
      readValue: () => Promise.resolve(''),
    });

    await expect(runGuided(options)).rejects.toThrow(/pnpm secrets:unset/);
  });
});
