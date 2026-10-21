# Development and releases

Use Node.js 22+ and a `zip` executable. The plugin currently targets Zotero 10.0.x.

```sh
npm ci
npm run check
```

This runs the test suite and builds:

- `dist/zotero2notion-<version>.xpi`
- `dist/updates.json` with the XPI version, compatibility, download URL, and SHA-256 hash.

GitHub Actions runs the same checks on pushes and pull requests. Use an isolated Zotero profile and data directory for runtime checks; do not run development scripts against your regular library.

## Source map

| File | Responsibility |
|---|---|
| `src/plugin.js` | Lifecycle, Zotero events, queues, settings |
| `src/notion.js` | API transport and bounded retries |
| `src/setup.js` | Resumable database creation |
| `src/sync.js` | Page matching, metadata updates, body preservation |
| `src/model.js` | Properties, template variables, matching rules |
| `src/zotero.js` | Metadata extraction |
| `src/storage.js` | Settings, templates, credential storage |
| `src/autosave.js` | Save batching and retry |
| `src/preferences.js` | Settings behavior |
| `addon/content/` | Settings markup and styles |
| `addon/templates/` | Bundled Markdown outlines |

## Publish a release

1. Update the version in `package.json`, `package-lock.json`, and `addon/manifest.json`, then update `CHANGELOG.md`.
2. Run `npm run check` and review the resulting XPI. The build fails if package and manifest versions differ.
3. Commit the change and tag it `v<version>`. Push the commit and tag.
4. Create a GitHub release for the tag and attach **both** generated files. Use the XPI and update manifest from the same build so their hashes match.
5. Check the release download and `https://github.com/legojeon/Zotero2Notion/releases/latest/download/updates.json`.

The updater is hosted in GitHub Releases; no separate server is needed. Keep the existing plugin ID so installed copies receive updates. Versions before 0.1.10 must be updated manually once to adopt the public update URL.

`Z2N_UPDATE_URL` can override the update manifest URL for a development build. Forks should also update the package repository URL and choose their own plugin ID before distributing releases.
