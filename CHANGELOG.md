# Changelog

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
