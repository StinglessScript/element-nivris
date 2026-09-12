/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// The installer's progress window, as an HTML Application run by mshta.exe.
//
// It exists because PowerShell is not a given. On a locked-down machine — the same one whose policy
// refused `schtasks /create` — the PowerShell progress window never drew anything, and every layer
// between it and the user (hidden wscript, detached process, GUI-subsystem exe) swallowed the
// reason. mshta is a different engine with its own policy and ships with every Windows, so it very
// often still runs there. It also draws with HTML and CSS, which is a far better fit for this
// design than WinForms' absolute coordinates.
//
// Placeholders (__STATUS_FILE__, __LOGO_B64__, __TITLE__) are substituted when the file is written;
// the HTA is generated per run anyway, so there's nothing to pass on a command line.
//
// Reading the status file goes through ADODB.Stream rather than FileSystemObject: FSO can only read
// ASCII or UTF-16, and everything the installer writes is UTF-8 Vietnamese.

export const HTA_HTML = String.raw`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>__TITLE__</title>
<hta:application id="app" applicationname="Nivris Installer" border="thin" caption="yes"
    maximizebutton="no" minimizebutton="yes" scroll="no" singleinstance="yes" sysmenu="yes"
    contextmenu="no" selection="no" innerborder="no" />
<style>
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: #0b1b26;
        background: #fff;
        overflow: hidden;
        user-select: none;
    }
    .wrap { padding: 36px 44px 0; }
    .brand { height: 52px; }
    .brand img { width: 52px; height: 52px; float: left; }
    .brand .name { margin-left: 66px; font-family: Consolas, monospace; font-size: 17px; font-weight: bold; letter-spacing: 1px; }
    .brand .sub { margin-left: 66px; margin-top: 4px; font-size: 13px; color: #5a7080; }
    h1 { margin: 62px 0 0; font-size: 27px; font-weight: 600; }
    h1.ok { color: #0a7c7a; }
    h1.err { color: #c4443f; }
    .track { margin-top: 34px; height: 6px; background: #e4e9ed; }
    .fill { height: 6px; width: 0; background: #0a7c7a; }
    .status { margin-top: 14px; font-size: 13px; color: #5a7080; }
    .msg { margin-top: 22px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; display: none; height: 150px; overflow: auto; }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 72px; padding: 20px 44px; text-align: right; display: none; }
    button {
        font-family: "Segoe UI", Tahoma, sans-serif;
        font-size: 13px;
        padding: 8px 18px;
        margin-left: 10px;
        border: 1px solid #adb5bd;
        background: #fff;
        color: #0b1b26;
        cursor: pointer;
    }
    button.primary { background: #0a7c7a; border-color: #0a7c7a; color: #fff; }
    #logview { display: none; position: absolute; left: 0; top: 0; right: 0; bottom: 0; background: #fff; padding: 16px; }
    #logtext { width: 100%; height: 88%; font-family: Consolas, monospace; font-size: 12px; white-space: pre; overflow: auto; border: 1px solid #e4e9ed; padding: 10px; }
</style>
</head>
<body>
<div class="wrap">
    <div class="brand">
        <img src="data:image/png;base64,__LOGO_B64__" />
        <div class="name">N.I.V.R.I.S.</div>
        <div class="sub">Module cho Element Desktop</div>
    </div>
    <h1 id="heading">Vui lòng đợi trong giây lát...</h1>
    <div class="track" id="track"><div class="fill" id="fill"></div></div>
    <div class="status" id="status">Đang chuẩn bị...</div>
    <div class="msg" id="msg"></div>
</div>
<div class="bar" id="bar">
    <button id="btnCopy" onclick="copyLog()">Sao chép nhật ký</button>
    <button id="btnView" onclick="viewLog()">Xem nhật ký</button>
    <button class="primary" onclick="window.close()">Đóng</button>
</div>
<div id="logview">
    <div id="logtext"></div>
    <div style="text-align:right;margin-top:10px"><button class="primary" onclick="hideLog()">Quay lại</button></div>
</div>
<script type="text/javascript">
var STATUS_FILE = "__STATUS_FILE__";
var logPath = "";
var fso = new ActiveXObject("Scripting.FileSystemObject");

window.resizeTo(740, 520);
window.moveTo(Math.max(0, (screen.availWidth - 740) / 2), Math.max(0, (screen.availHeight - 520) / 2));

/* ADODB.Stream, not FileSystemObject: FSO reads ASCII or UTF-16 only, and every file the installer
   writes is UTF-8. */
function readUtf8(path) {
    try {
        if (!fso.FileExists(path)) return null;
        var s = new ActiveXObject("ADODB.Stream");
        s.Type = 2;
        s.Charset = "utf-8";
        s.Open();
        s.LoadFromFile(path);
        var text = s.ReadText();
        s.Close();
        return text;
    } catch (e) {
        return null;
    }
}

function markReady() {
    try {
        var dir = fso.GetParentFolderName(STATUS_FILE);
        fso.CreateTextFile(fso.BuildPath(dir, "ready.marker"), true).Close();
    } catch (e) {}
}

function viewLog() {
    var text = logPath ? readUtf8(logPath) : null;
    document.getElementById("logtext").innerText = text === null ? "Chưa có nhật ký: " + logPath : text;
    document.getElementById("logview").style.display = "block";
}
function hideLog() {
    document.getElementById("logview").style.display = "none";
}
function copyLog() {
    var text = logPath ? readUtf8(logPath) : null;
    try {
        window.clipboardData.setData("Text", text === null ? "(khong doc duoc nhat ky)" : text);
        alert("Đã sao chép nhật ký vào clipboard.");
    } catch (e) {
        alert("Không sao chép được. Bấm \"Xem nhật ký\" rồi bôi đen để chép tay.");
    }
}

var done = false;
function tick() {
    if (done) return;
    var raw = readUtf8(STATUS_FILE);
    if (raw === null || raw === "") return;
    var s;
    try { s = eval("(" + raw + ")"); } catch (e) { return; }
    var pct = Math.max(0, Math.min(100, parseInt(s.percent, 10) || 0));
    document.getElementById("fill").style.width = pct + "%";
    document.getElementById("status").innerText = s.label || "";
    if (s.done) {
        done = true;
        logPath = s.logPath || "";
        var h = document.getElementById("heading");
        h.innerText = s.ok ? "Đã cài xong" : "Cài đặt gặp lỗi";
        h.className = s.ok ? "ok" : "err";
        document.getElementById("track").style.display = "none";
        document.getElementById("status").style.display = "none";
        var msg = document.getElementById("msg");
        msg.innerText = s.message || "";
        msg.style.display = "block";
        document.getElementById("bar").style.display = "block";
        window.focus();
    }
}

markReady();
window.setInterval(tick, 120);
</script>
</body>
</html>
`;
