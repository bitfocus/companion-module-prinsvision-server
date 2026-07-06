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
in Companion and fill in Host, Port, API Key and Pair Code from
**PatchBay Config → Companion** in the Prins Vision Control UI. All four are
required — connections without a valid pair code are rejected.

## Development

```sh
npm install
npm run build      # tsc → dist/ (dev-mode entrypoint)
npm run package    # build + bundle a distributable .tgz
```

`src/version.ts` and `companion/manifest.json` are kept in sync with
`package.json` by `scripts/sync-version.mjs` (runs on every build). Bump the
version in `package.json` only.

## License

[MIT](LICENSE)
