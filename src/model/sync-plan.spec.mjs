import { describe, expect, it } from 'vitest';

import { parseSyncArgs } from './sync-plan.mjs';
import { DEPLOYABLE_APPS } from '../scopes.mjs';

describe('parseSyncArgs and the deployable list', () => {
  it('syncs the deployable apps by default and never ingest', () => {
    const { apps } = parseSyncArgs(['staging']);
    expect(apps).toEqual([...DEPLOYABLE_APPS]);
    expect(apps).not.toContain('ingest');
  });

  it('refuses ingest by name until it has a Railway service', () => {
    expect(() => parseSyncArgs(['staging', 'ingest'])).toThrow(
      /Unknown app "ingest"/,
    );
  });
});
