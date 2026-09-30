# Release Checklist

This repo publishes two artifacts for each release:

- npm package: `@agegr/pi-web`
- GitHub Release: `agegr/pi-web`

Use this checklist from a clean `main` checkout.

## 1. Preflight

```bash
git status --short --branch
git log --oneline --decorate -5
gh auth status
npm whoami
node -e "const p=require('./package.json'); console.log(p.version)"
```

Expected:

- `git status` is clean, or only contains changes you intentionally plan to release.
- GitHub is authenticated as an account that can push and create releases.
- npm is authenticated as an account that can publish `@agegr/pi-web`.

## 2. Publish to npm

```bash
npm run release
```

The release script runs:

```bash
npm version patch --no-git-tag-version && npm run build && npm publish --access public
```

Notes:

- This bumps `package.json` and `package-lock.json`.
- It intentionally runs a production build. Do not run `next build` during normal development; release work is the exception.
- If `npm view @agegr/pi-web version` briefly shows the previous version, check the exact version instead:

```bash
npm view @agegr/pi-web@<version> version --registry https://registry.npmjs.org/
npm view @agegr/pi-web versions --json --registry https://registry.npmjs.org/
```

## 3. Commit the Version Bump

Replace `<version>` with the new package version, for example `0.7.5`.

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

## 4. Tag and Push

```bash
git tag -a v<version> -m "v<version>"
git push origin main --tags
```

Confirm the tag does not already exist before creating it when unsure:

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo agegr/pi-web
```

## 5. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes next to each item when useful.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `@agegr/pi-web@<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `@agegr/pi-web@<version>`.
```

## 6. Create or Update the GitHub Release

Create a new release:

```bash
gh release create v<version> \
  --repo agegr/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file release-notes.md
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version> \
  --repo agegr/pi-web \
  --notes-file release-notes.md
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo agegr/pi-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. Final Verification

```bash
gh release view v<version> --repo agegr/pi-web
npm view @agegr/pi-web@<version> version --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- npm exact version resolves.
- `main` is aligned with `origin/main`.
- `HEAD` points at the release commit and `v<version>` tag.

## Local Service Replacement (2026-09-29)

This is a local override, not an npm or GitHub release:

- In RPC mode, `@juicesharp/rpiv-ask-user-question` folds option previews into the `select` title. A long preview can occupy the space above the options. Pi Web now leaves the first paragraph visible and puts subsequent title paragraphs in a closed, expandable details section (`components/ChatWindow.tsx`). The desktop and mobile extension-dialog E2E test covers this behavior.
- Build a local replacement from a source snapshot **outside this repository**, passing that directory to `next build --webpack`. The root `tsconfig.json` includes `**/*.ts`/`**/*.tsx`: copying the source into `outputs/` and building from the repo root made type checking scan two copies, causing duplicate globals and misleading SDK export errors. A production build also writes to `.next`; do not run it in the dev checkout. Keep or inspect any pre-existing `.next` content before cleaning up a failed build.
- Pack the isolated build and install the tarball globally when the terminal `pi-web` command must use the replacement. Check that the tarball includes `.next/BUILD_ID` and `bin/pi-web.js`, then check `pi-web --help` and the installed build before considering it deployed. A source-only dev server on another port does not update the global command.
- Installing a replacement is **not** permission to start the service or open a browser. Leave port 30141 stopped unless the operator explicitly asks to start it; they will run `pi-web` themselves. A process started through the agent's tool shell may receive `Ctrl+C` when that shell ends, so a transient HTTP 200 is not proof of a persistent service. Use `pi-web --no-open` only when startup was explicitly requested without browser opening.
