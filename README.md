# companion-module-prinsvision-server

A [Bitfocus Companion](https://bitfocus.io/companion) module for controlling a
**Prins Vision** color grading system from a Stream Deck or other Companion surface.

It connects to a Prins Vision Core server over Socket.IO and exposes slot
selection, grading undo/redo, node toggles, wheel resets, preset apply/save,
and RAW/Bypass/Grade preview control as Companion actions, feedbacks and
variables.

## Requirements

- Bitfocus Companion **4.3** or newer (built against `@companion-module/base` 2.0)
- A reachable Prins Vision Core server
- A logged-in Prins Vision Control UI session to pair with

## Setup

See [`companion/HELP.md`](companion/HELP.md) for the full setup, actions,
feedbacks and variables reference. In short: add a **Prins Vision** connection
in Companion, pick the discovered system (or fill in Host and Port) and paste the
Pair Code from **PatchBay Config → Companion** in the Prins Vision Control UI. The
pair code is the only key — connections without a valid code are rejected.

Module 3.0.0 drops the separate API key: generate a pair code in PrinsVision and
paste it into the connection again.

Module 2.4.0 adds **Router + TSL** in Patch Bay Config → Companion → Slot follow.
Map SW-P-08 inputs/output and TSL addresses there, then export/import the generated
Companion triggers into your existing connections. Optional slot-to-router
switching is separate from router feedback to prevent loops. This mode requires
Companion 5.0.6+; see the setup and limitations in `companion/HELP.md`.

## Development

```sh
npm install
npm run build      # tsc → dist/ (dev-mode entrypoint)
npm run package    # build + bundle a distributable .tgz
```

`src/version.ts` and `companion/manifest.json` are kept in sync with
`package.json` by `scripts/sync-version.mjs` (runs on every build). Bump the
version in `package.json` only.

## Distribution

The **canonical store repository** is
[`bitfocus/companion-module-prinsvision-server`](https://github.com/bitfocus/companion-module-prinsvision-server),
which is submitted to the Bitfocus module store. This repository is a public
release mirror; active development happens in the Prins Vision monorepo, from
where the module is also bundled into the Core app for in-app installation.

## License

[MIT](LICENSE)
