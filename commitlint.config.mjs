/**
 * Conventional Commits. Same config for the local `commit-msg` hook and for
 * the `pr-title` workflow (the squash subject on main is the PR title).
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // PR titles carry `(#123)` and a scope; the preset's 100 is tight.
    'header-max-length': [2, 'always', 120],
    // English sentence case, not enforced.
    'subject-case': [0],
  },
};
