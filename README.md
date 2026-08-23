# N.I.V.R.I.S.

Neural Intelligence & Virtual Reasoning Interface System — an Element
Desktop module that lets you create "sessions" tracking a person, a room,
unresponded @mentions, or priority-keyword messages, and get on-demand AI
summaries of what's happening in them.

Everything runs locally: messages are ingested into IndexedDB (7-day
retention) as they arrive, and are only sent anywhere when you press
"Phân tích" — to an Anthropic-compatible endpoint you configure yourself
(model / base URL / API key, in the module's own Settings panel).

Fully standalone — no element-web monorepo checkout needed to build or install it.

## Install into an already-installed Element Desktop

One command, no manual `git clone`:

```bash
npx -y -p github:StinglessScript/element-nivris nivris-install
```

- macOS: patches `/Applications/Element.app`.
- Windows: patches `%LOCALAPPDATA%\Element\app-x.y.z` (Squirrel install) — untested, please report issues.
- A different install location: set `ELEMENT_APP_PATH=/path/to/Element.app` (or the Windows `app-x.y.z` folder) before the command.

No rebuild or re-signing of Element itself: it builds the module, unpacks
`webapp.asar` into a plain `webapp/` folder (Element's own resource loader
falls back to that when the asar is missing), drops the built module in as
`webapp/modules/nivris.js`, and registers it via the user's local
`config.json` `"modules"` array.

To remove it:

```bash
npx -y -p github:StinglessScript/element-nivris nivris-uninstall
```

Element's own auto-updater will overwrite the patched files on update —
re-run the install command afterwards.

## Develop

```bash
npm install
npm run build       # vite build -> lib/index.js
npm run lint:types  # tsc --noEmit
npm run install:live   # same as npx nivris-install, but from a local checkout
```
