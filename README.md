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

- macOS: patches `/Applications/Element.app`. No `sudo` needed (just a one-time "App Management" permission grant the first time — the command's own error message tells you exactly where to enable it if it's missing).
- Windows: patches `%LOCALAPPDATA%\Element\app-x.y.z` (Squirrel install) — untested, please report issues.
- Linux: patches a `.deb`/apt install at `/opt/Element` — needs `sudo`, since `/opt` is root-owned:
  ```bash
  sudo npx -y -p github:StinglessScript/element-nivris nivris-install
  ```
  **AppImage and Snap are not supported** — an AppImage remounts a fresh read-only image every
  run, so there's nowhere to persist a patch, and Snap's sandbox blocks writes outside its own
  data directory. Use the `.deb` package instead.
- A different install location: set `ELEMENT_APP_PATH=/path/to/Element.app` (or the Windows `app-x.y.z` folder, or the Linux dir containing `resources/`) before the command.

**Getting `npm error EBADDEVENGINES` / `required: { name: 'pnpm', ... }`?** That means the
directory you ran the command from has its own `package.json` requiring `pnpm` (e.g. you're
sitting inside a `pnpm`-managed repo's checkout) — `npm`/`npx` check the *current directory* for
a `devEngines`/`packageManager` declaration, not just the package being installed. Run the exact
same command from a different directory (your home directory, `/tmp`, anywhere without that
`package.json` above it) and it'll go through fine.

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
