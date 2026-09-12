@echo off
setlocal
chcp 65001 >nul
title N.I.V.R.I.S. - Cai dat cho Element

echo ====================================
echo  N.I.V.R.I.S. - Cai dat cho Element
echo ====================================
echo.

rem Truoc day file nay bat nguoi dung tu di cai Node.js roi quay lai chay lai. Gio no tu lo:
rem may nao co san Node thi dung luon, may nao khong thi tai ban portable ve thu muc tam.
rem Day cung la duong cai duy nhat chay duoc tren Windows 10 cu hon build 17763, vi ban .exe
rem (dong goi bang Bun) can API ClosePseudoConsole chi co tu 1809 tro len.
set "NODEDIR=%TEMP%\nivris-node"

where npx >nul 2>nul
if not errorlevel 1 goto run

if exist "%NODEDIR%\npx.cmd" goto usetemp

echo Chua tim thay Node.js tren may nay.
echo Dang tai Node.js ban portable ve thu muc tam - KHONG cai gi vao may.
echo.

call :fetchnode
if errorlevel 1 goto nonode

:usetemp
set "PATH=%NODEDIR%;%PATH%"
where npx >nul 2>nul
if errorlevel 1 goto nonode
echo Dang dung Node.js portable tai: %NODEDIR%
echo.

:run
call npx -y -p github:StinglessScript/element-nivris nivris-install
set STATUS=%ERRORLEVEL%

echo.
if %STATUS%==0 (
    echo Xong! Dong han Element roi mo lai de thay N.I.V.R.I.S.
) else (
    echo Cai dat gap loi ^(xem chi tiet o tren^). Neu can, mo Command Prompt bang
    echo "Run as administrator" roi chay lai file nay.
)
echo.
pause
exit /b %STATUS%

:nonode
echo.
echo Khong tai duoc Node.js tu dong ^(co the do mang hoac tuong lua^).
echo Cach thu cong: cai Node.js ban LTS tai https://nodejs.org roi chay lai file nay.
echo.
pause
exit /b 1

rem Tai ban LTS v20 thay vi ban moi nhat: v20 con chay duoc tren nhung ban Windows 10 cu,
rem dung cai may ma file .exe da bo cuoc. Version cu the doc tu index.json chu khong ghi cung,
rem de khong phai sua file nay moi lan Node ra ban va.
rem ZipFile.ExtractToDirectory thay cho Expand-Archive vi Expand-Archive can PowerShell 5,
rem con may cu chi co PowerShell 4.
:fetchnode
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference='Stop';" ^
 "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
 "$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {'arm64'} elseif ([Environment]::Is64BitOperatingSystem) {'x64'} else {'x86'};" ^
 "$v = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.version -like 'v20.*' } | Select-Object -First 1).version;" ^
 "$name = 'node-' + $v + '-win-' + $arch;" ^
 "$zip = Join-Path $env:TEMP 'nivris-node.zip';" ^
 "Invoke-WebRequest ('https://nodejs.org/dist/' + $v + '/' + $name + '.zip') -OutFile $zip -UseBasicParsing;" ^
 "$outer = Join-Path $env:TEMP $name;" ^
 "if (Test-Path $outer) { Remove-Item $outer -Recurse -Force };" ^
 "$dest = Join-Path $env:TEMP 'nivris-node';" ^
 "if (Test-Path $dest) { Remove-Item $dest -Recurse -Force };" ^
 "Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
 "[IO.Compression.ZipFile]::ExtractToDirectory($zip, $env:TEMP);" ^
 "Move-Item $outer $dest;" ^
 "Remove-Item $zip -Force"
exit /b %ERRORLEVEL%
