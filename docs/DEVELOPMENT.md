# Development

Node.js 22+ is the only runtime dependency. No install is needed for `npm test` or `npm run package`. Tests use synthetic inputs and write ignored local artifacts. The packager refuses to overwrite an existing destination.

## Optional browser checks

Install Playwright explicitly in this checkout:

```sh
npm install --no-save --package-lock=false playwright
```

Set `DW_BROWSER_BIN` to an existing Chrome/Edge/Chromium executable, or explicitly install Playwright's browser. Set `PLAYWRIGHT_BROWSERS_PATH` before downloading a browser to choose the cache directory. Start `node server.mjs` in one terminal, then use another terminal for:

```sh
node test/browser.mjs
node test/editor-race.mjs
node test/multi-window.mjs
```

These checks use the default loopback port 6410. They write profiles and evidence under ignored `.runtime/` and `output/` folders, and use explicitly labeled model fixtures. Do not upload these artifacts or your drafts.

## Preparing model acceptance inputs

```sh
node scripts/prepare-model-cases.mjs
```

This prepares two fictional three-draft cases, one normal and one containing protected values, a locked paragraph and unresolved contradictory claims. It prints the exact prepared-project paths. No authentication or inference takes place. Use a printed path with `node scripts/check-model.mjs --prepare-only --project <prepared.json>`. Real inference requires an explicitly configured provider, as described in [model configuration](MODELS.md).

Review a successful result against each case's generated manual criteria: whole-document transitions, consistent terminology, repeated introductions, references, unchanged protected facts and retained unresolved conflicts. Transport success does not establish semantic quality. Real model quality has not yet been validated.
