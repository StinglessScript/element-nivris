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

## Install (không rành dòng lệnh)

Vào trang **[Releases](https://github.com/StinglessScript/element-nivris/releases/latest)** và
tải file phù hợp — **luôn tải từ trang Releases**, không tải file lẻ qua nút "Raw" trên GitHub
(cách đó làm mất quyền thực thi của file, double-click sẽ không chạy được).

### macOS — không cần cài Node.js, có icon riêng, không hiện Terminal (khuyến nghị)

1. Tải `NivrisInstaller-macOS.zip` — 1 file duy nhất, chạy được cả Mac chip Apple lẫn Intel.
2. Double-click file `.zip` vừa tải để giải nén (macOS tự làm), ra 1 app tên
   **NivrisInstaller** có icon riêng.
3. Double-click app đó. macOS bản mới (Sonoma/Sequoia trở lên) sẽ chặn thẳng ("không xác định
   được nhà phát triển", chỉ có nút "Move to Trash"/"Done", **không còn** nút Open ở menu chuột
   phải nữa) — xử lý như sau:
   - Vào **System Settings → Privacy & Security**, cuộn xuống gần cuối trang (dưới mục "Allow
     applications from") — sẽ thấy dòng `"NivrisInstaller" was blocked...` kèm nút
     **Open Anyway**. Bấm vào, nhập mật khẩu/Touch ID để xác nhận.
   - Nếu chưa thấy dòng đó: double-click lại app 1 lần nữa rồi vào Settings ngay sau đó — dòng
     này chỉ hiện trong ít phút sau lần bị chặn gần nhất.
   - Quay lại double-click app — lần này sẽ hiện dialog có nút **Open** thật, bấm vào.
4. App chạy ẩn (không hiện cửa sổ Terminal), rồi hiện 1 popup báo kết quả — bấm OK.
5. Tắt hẳn Element (Cmd+Q, không chỉ đóng cửa sổ) rồi mở lại.

Nếu popup báo lỗi "Không có quyền ghi..." — vào **System Settings → Privacy & Security → App
Management**, bật cho **NivrisInstaller**, rồi mở lại app.

Gỡ cài đặt tương tự bằng `NivrisUninstaller-macOS.zip` ở cùng trang Releases.

File này tự chứa mọi thứ cần thiết (không cần Node.js, không cần cài gì thêm trước).

### Windows — không cần cài Node.js, không hiện cửa sổ đen (khuyến nghị)

1. Tải `NivrisInstaller-Windows.exe`.
2. Double-click. Windows Defender SmartScreen có thể chặn ("Windows protected your PC") — bấm
   **More info**, rồi bấm **Run anyway**.
3. App chạy ẩn (không hiện Command Prompt), rồi hiện 1 popup báo kết quả — bấm OK.
4. Đóng hết cửa sổ Element rồi mở lại.

Gỡ cài đặt tương tự bằng `NivrisUninstaller-Windows.exe` ở cùng trang Releases.

### macOS / Windows — cần cài Node.js trước

Máy cần cài sẵn [Node.js](https://nodejs.org) (bản LTS) — chỉ cài 1 lần. Sau đó, từ trang
Releases:

- **macOS**: tải `Install-Nivris-Mac.zip`, double-click để giải nén, rồi double-click file
  `.command` bên trong. Gặp Gatekeeper chặn thì xử lý y như bước 3 ở mục trên.
- **Windows**: tải `Install-Nivris-Windows.bat`, double-click chạy thẳng (không cần giải nén).

Một cửa sổ đen (Terminal/Command Prompt) hiện ra, tự chạy và báo kết quả — không cần gõ gì. Xong
thì tắt hẳn Element (Cmd+Q trên macOS, hoặc đóng hết cửa sổ trên Windows) rồi mở lại.

Gỡ cài đặt tương tự bằng `Uninstall-Nivris-Mac.zip` / `Uninstall-Nivris-Windows.bat` (cũng ở
trang Releases).

## Install into an already-installed Element Desktop (dòng lệnh)

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

To rebuild the standalone macOS `.app` installers (needs [Bun](https://bun.com) — maintainer-only
tooling, end users don't need any of this):

```bash
npm run build:standalone-mac   # -> dist/NivrisInstaller-macOS.zip, dist/NivrisUninstaller-macOS.zip
```

Builds a universal binary (arm64 + x64 via `lipo`, x64 cross-compiled and untested on real Intel
hardware) wrapped in a real `.app` bundle — icon, no visible Terminal window, reports success/
failure via a native dialog.

The Windows `.exe` installers are built by the `build-windows-installer.yml` GitHub Actions
workflow (`gh workflow run build-windows-installer.yml`, then download the
`nivris-windows-installers` artifact) rather than locally — Bun's `--windows-hide-console` and
`--windows-icon` flags only work when compiling *on* Windows, so cross-compiling from macOS/Linux
can't produce a polished (no console flash, custom icon) build; it has to run on an actual
Windows machine, which the workflow's `windows-latest` runner provides.

App icons live at `assets/icons/AppIcon.icns` / `AppIcon.ico` (both committed — regenerate via
`python3 scripts/draw-app-icon.py <iconset-dir>` + `iconutil`/`Pillow` if the design changes).

Either way, attach the resulting files to a new GitHub Release — they're too large to commit
(~50-90MB each, since they embed the whole Bun runtime).
