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

### macOS — không cần cài Node.js (khuyến nghị)

1. Tải đúng 1 file theo loại chip máy:
   - Chip Apple (M1/M2/M3/M4...): `NivrisInstaller-macOS-AppleSilicon.zip`
   - Chip Intel (đời cũ hơn): `NivrisInstaller-macOS-Intel.zip`

   Không biết máy mình loại nào? Bấm logo Apple góc trái màn hình → "Giới thiệu về Mac này" —
   xem dòng "Chip"/"Bộ xử lý".
2. Double-click file `.zip` vừa tải để giải nén (macOS tự làm), ra 1 file không có đuôi mở rộng.
3. Double-click file đó. macOS bản mới (Sonoma/Sequoia trở lên) sẽ chặn thẳng ("không xác định
   được nhà phát triển", chỉ có nút "Move to Trash"/"Done", **không còn** nút Open ở menu chuột
   phải nữa) — xử lý như sau:
   - Vào **System Settings → Privacy & Security**, cuộn xuống gần cuối trang (dưới mục "Allow
     applications from") — sẽ thấy dòng `"NivrisInstaller-macOS-..." was blocked...` kèm nút
     **Open Anyway**. Bấm vào, nhập mật khẩu/Touch ID để xác nhận.
   - Nếu chưa thấy dòng đó: double-click lại file 1 lần nữa rồi vào Settings ngay sau đó — dòng
     này chỉ hiện trong ít phút sau lần bị chặn gần nhất.
   - Quay lại double-click file — lần này sẽ hiện dialog có nút **Open** thật, bấm vào.
4. Một cửa sổ Terminal hiện ra, tự chạy và báo kết quả — không cần gõ gì.
5. Tắt hẳn Element (Cmd+Q, không chỉ đóng cửa sổ) rồi mở lại.

File này tự chứa mọi thứ cần thiết (không cần Node.js, không cần cài gì thêm trước).

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

To rebuild the standalone macOS installers (needs [Bun](https://bun.com) — this is a
maintainer-only tool, end users don't need it):

```bash
npm run build:standalone-mac-arm64   # -> dist/NivrisInstaller-macOS-AppleSilicon
npm run build:standalone-mac-intel   # -> dist/NivrisInstaller-macOS-Intel (cross-compiled, untested on real Intel hardware)
```

Then attach both to a new GitHub Release (they're too large to commit — ~65-70MB each, since
they embed the whole Bun runtime).
