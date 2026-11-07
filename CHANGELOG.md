# Changelog

## v1.3.0 — 2026-11-07

- **Background jobs** (optional): `server/copyjobs.mjs`, a small service that runs the copy or move
  on the server, so the data no longer goes through the browser. From a phone on a weak connection a
  file of several GB is now fine: the page only sends the paths and can be closed while it runs.
  It acts with each person's own Filestash session, so the backend's rules still apply, and never
  stores a cookie or a password. Docker image and a complete `compose.yaml` example in the README.
  Without the service nothing changes.
- When the service answers, the plugin shows **In background** (or **Move in background**) next to
  *Paste here*. Progress (name, bytes, speed, bar) is a strip fixed at the bottom of the page, outside
  the toolbar, which is wider than a phone screen; tapping it opens the list of jobs, with Cancel and
  Dismiss. A finished job announces itself, and a move still asks before it deletes the source.
- New messages in English and Spanish; the other languages show them in English until translated
  (`test/locales.mjs` now accepts a language lacking the newest keys, but not an extra or misordered one).
- Tests: `test/server.mjs` (the service against a real Filestash and Samba, in CI) and a background
  scenario in `test/ui.mjs`.
- `AGENTS.md` (and a `CLAUDE.md` that includes it): the rules that are not obvious when changing the code.

## v1.2.1 — 2026-10-24

- **License changed from MIT to the GNU AGPL v3.0**, the license of Filestash itself.
  v1.2.0 as released stays available under MIT.
- `copypaste.zip` now carries the `LICENSE` file.
- No change to the code.

## v1.2.0 — 2026-10-24

First public release.

- **Copy**, **Cut** and **Paste here** in the files toolbar, with Ctrl/Cmd+C, X and V. The clipboard
  is shared by every tab of the same browser; cut items are dimmed.
- **Drag and drop between Samba shares** (onto a folder in the list, the sidebar tree or the breadcrumb,
  or from another tab), which Filestash refuses on its own.
- A move is first the backend's own rename (instant, keeps the dates). Only what the backend refuses
  with 501 Not Implemented, such as Samba across shares, is copied and then removed from the source,
  after a confirmation, and only once the whole copy has succeeded.
- Every language Filestash ships (43), chosen the way Filestash chooses its own.
- Tests: offline (engine, UI, translations) and an integration test against Filestash and a real
  Samba server in Docker, run in CI on every push and weekly against `machines/filestash:latest`.

Versions 1.0 (copy and paste) and 1.1 (cut) were private, the same day.
