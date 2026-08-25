@echo off
setlocal
chcp 65001 >nul
title N.I.V.R.I.S. - Go cai dat khoi Element

echo =======================================
echo  N.I.V.R.I.S. - Go cai dat khoi Element
echo =======================================
echo.

where npx >nul 2>nul
if errorlevel 1 (
    echo Chua tim thay Node.js tren may nay.
    echo Cai Node.js ^(ban LTS^) tai https://nodejs.org roi chay lai file nay.
    echo.
    pause
    exit /b 1
)

call npx -y -p github:StinglessScript/element-nivris nivris-uninstall
set STATUS=%ERRORLEVEL%

echo.
if %STATUS%==0 (
    echo Xong! Dong han Element roi mo lai.
) else (
    echo Go cai dat gap loi ^(xem chi tiet o tren^).
)
echo.
pause
