# Releases

This fork has no CI or automated publishing jobs. Verify and release locally.

## Local verification

Run from a clean checkout:

```sh
npm install
npm run format
npm run check
npm run build
npm run test:run
```

Integration tests are optional because they require external credentials:

```sh
npm run test:integration
```

## Versioning

- For an upstream release such as `v0.70.1`, use `v0.70.1-custom`.
- For commits after the latest upstream release, append an interstitial patch,
  such as `v0.70.1.1-custom` and `v0.70.1.2-custom`.
- Reset to the matching `-custom` version when upstream publishes its next tag.

## Create a release

```sh
VERSION=v<version>-custom
git tag "$VERSION"
git push origin main "$VERSION"
gh release create "$VERSION" \
  --title "$VERSION" \
  --generate-notes \
  --repo rohan-patra/claude-agent-acp
```

Verify the published release:

```sh
gh release view "$VERSION" --repo rohan-patra/claude-agent-acp
```

## Replace an existing release

Only use this when intentionally moving an existing release to the current
commit:

```sh
VERSION=v<version>-custom
gh release delete "$VERSION" --yes --cleanup-tag \
  --repo rohan-patra/claude-agent-acp
git tag -d "$VERSION"
git tag "$VERSION" HEAD
git push origin "$VERSION"
gh release create "$VERSION" \
  --title "$VERSION" \
  --generate-notes \
  --repo rohan-patra/claude-agent-acp
```
