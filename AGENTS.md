# Working on copypaste

A [Filestash](https://github.com/mickael-kerjean/filestash) runtime plugin (copy, cut and paste, also between
Samba shares) plus an optional service that runs the same copy on the server. The README says what it does
and how to use it; this file is what is easy to get wrong when changing it.

## Run the tests

```sh
node test/locales.mjs && node test/mock.mjs && node test/ui.mjs es-ES && node test/ui.mjs en-US   # offline, no dependencies
python3 -I build.py                                                                                # dist/copypaste.zip
```

The live ones need Docker (`ci/up.sh` starts Filestash and a throwaway Samba, `ci/down.sh` removes them):
`test/served-check.sh`, `test/e2e.mjs` (the engine) and `test/server.mjs` (the background service). Pass the
base URL as `http://localhost:PORT/`, never `127.0.0.1`: see "Filestash's host check" below. CI runs all of
them on every push and every Monday against the latest Filestash image, so a red Monday run means Filestash
changed under us.

## Rules that are not obvious

- **`src/engine.js` has no DOM, on purpose.** The browser (`copy.js`) and the Node service
  (`server/copyjobs.mjs`) both import it. A change there changes both. Its `config.fetch` is a module-level
  singleton; the service gives each job its own session with `AsyncLocalStorage`, so don't add other
  per-job module state to the engine.
- **The patch is one line with no context** (`src/ctrl_submenu.diff`), so upstream edits to that file don't
  break it. Keep it that way; everything else lives in our own modules.
- **A new file in `src/` must be added to the `names` list in `build.py`**, or it is not in the zip. The
  `__V__` placeholder in module URLs is replaced by a hash of the sources, because Filestash serves plugin
  files with a 30-day cache: always rebuild after editing, and keep imports as `./x.js?v=__V__`. The zip is
  reproducible (CI checks it). `server/` is not in the zip.
- **Translations**: `en.json` is the reference and `es.json` must stay complete. Other languages may lack the
  newest keys (English is shown) but must not have extra or misordered ones. Placeholders are `{{name}}`;
  messages with a count are objects keyed by `Intl.PluralRules` category. All translations are machine ones.
- **Don't put anything the user must see in Filestash's toolbar.** It is a no-wrap row wider than a phone
  screen, so a button there can be off screen. Progress and the job list live in a dock fixed near the bottom
  of the page, above Filestash's own notices, which sit at the very bottom.
- **Filestash's host check.** Filestash answers only to its configured `general.host`; a request addressed to
  any other name (`127.0.0.1`, a container name) gets `403`. The service therefore calls Filestash by that
  name, and a `401` from the service can mean "no session" or "Filestash refused me".
- **Session cookie**: Filestash's `auth` cookie has `Path=/api/`, is `HttpOnly` and `SameSite=Strict`, and
  cookies are not isolated by port. That is why the service's endpoints live under `/api/copyjobs` and why it
  forwards only cookies named `auth*`. Never log or persist a cookie or a password; `jobs.json` holds paths
  and states only. The service must stay a *client* of Filestash, never a second way into the storage.
- **The service has no dependencies** (Node 20 or later). Keep it that way.

## Behaviour that must not regress

- Never overwrite: a taken name gets a localised ` (copy)` suffix.
- A copy that fails or is cancelled removes the half-written file, and every file's size is checked against
  the listing.
- A move is the backend's own rename when it can (instant, keeps the dates); only what the backend refuses
  with `501` is copied, and the source is deleted only after the whole copy succeeded. That kind of move asks
  first, in the page and in the service. A whole share can't be moved.

## Style and release

- English for code, comments, README, CHANGELOG and commits. Changes go through a pull request with CI green.
- To release: bump `version` in `src/manifest.json` (`vX.Y.Z`) and `package.json` (`X.Y.Z`), turn
  "Unreleased" in `CHANGELOG.md` into `## vX.Y.Z — date` (the release notes are cut from that heading), then
  push the tag `vX.Y.Z`. The workflow refuses a tag that differs from the manifest.
- **This repository is public.** Never commit hostnames, IP addresses, paths, usernames or service names from
  anyone's own network or setup, and never credentials. Examples use placeholders (`nas.lan`, `alice`); the
  only credential in the repo is the CI's own test-only one, which guards a throwaway container.
