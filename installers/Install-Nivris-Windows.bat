@echo off
setlocal
chcp 65001 >nul
title N.I.V.R.I.S. - Cai dat cho Element

echo ====================================
echo  N.I.V.R.I.S. - Cai dat cho Element
echo ====================================
echo.

where npx >nul 2>nul
if errorlevel 1 (
    echo Chua tim thay Node.js tren may nay.
    echo Buoc 1: Cai Node.js ^(ban LTS^) tai https://nodejs.org
    echo Buoc 2: Sau khi cai xong, chay lai file nay.
    echo.
    pause
    exit /b 1
)

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
