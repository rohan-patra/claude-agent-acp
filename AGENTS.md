# Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
npm run format        # prettier --write
npm run check         # eslint + prettier --check
npm run build         # tsc
npm run test:run      # vitest, single pass
```

## Local verification only

This fork has no GitHub Actions workflows. Run all four commands above locally
before pushing changes or creating a release. Do not restore upstream workflow
files during merges.

## Releasing

Releases are created manually with `git tag`, `git push`, and `gh release create`.
Use the fork's `-custom` version scheme documented in
[`docs/RELEASES.md`](docs/RELEASES.md).
