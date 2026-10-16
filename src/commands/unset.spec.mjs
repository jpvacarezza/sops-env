import { describe, expect, it, vi } from 'vitest';

const setMain = vi.hoisted(() => vi.fn(() => 42));

vi.mock('./set.mjs', () => ({ main: setMain }));

const { main } = await import('./unset.mjs');

describe('unset', () => {
  it('runs the set command in unset mode and returns its status', () => {
    const ctx = {};
    const argv = ['api.DATABASE_URL', '--local'];

    expect(main(ctx, argv)).toBe(42);
    expect(setMain).toHaveBeenCalledWith(ctx, argv, { mode: 'unset' });
  });
});
