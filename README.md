# N.I.V.R.I.S.

Neural Intelligence & Virtual Reasoning Interface System — an Element
Desktop module that lets you create "sessions" tracking a person, a room,
unresponded @mentions, or priority-keyword messages, and get on-demand AI
summaries of what's happening in them.

Everything runs locally: messages are ingested into IndexedDB (7-day
retention) as they arrive, and are only sent anywhere when you press
"Phân tích" — to an Anthropic-compatible endpoint you configure yourself
(model / base URL / API key, in the module's own Settings panel).

## Requirements

This module is built with `@element-hq/element-web-module-api`, a
workspace package inside the [element-hq/element-web](https://github.com/element-hq/element-web)
monorepo. It cannot be built standalone — drop this folder in as
`modules/nivris/` inside a checkout of that repo (it's already part of the
`modules/*` pnpm workspace glob there), then `pnpm install` from the repo
root.

## Install into an already-installed Element Desktop

No rebuild or re-signing of Element itself required:

```bash
cd modules/nivris
npm run install:live      # macOS: /Applications/Element.app
                           # Windows: %LOCALAPPDATA%\Element\app-x.y.z (untested — please report issues)
```

Point at a different install with `ELEMENT_APP_PATH=/path/to/Element.app` (or the Windows `app-x.y.z` folder).

To remove it: `npm run uninstall:live`.

Element's own auto-updater will overwrite the patched files on update —
re-run `install:live` afterwards.

## Develop

```bash
npm run build       # vite build -> lib/index.js
npm run lint:types  # tsc --noEmit
```
