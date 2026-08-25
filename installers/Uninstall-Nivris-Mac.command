#!/bin/bash
# Double-click this file in Finder to remove N.I.V.R.I.S. from Element Desktop.
cd "$(dirname "$0")" || exit 1

echo "======================================="
echo " N.I.V.R.I.S. - Go cai dat khoi Element"
echo "======================================="
echo

if ! command -v npx >/dev/null 2>&1; then
    echo "Chua tim thay Node.js tren may nay."
    echo "Cai Node.js (ban LTS) tai https://nodejs.org roi chay lai file nay."
    echo
    read -n 1 -s -r -p "Nhan phim bat ky de dong cua so nay..."
    exit 1
fi

npx -y -p github:StinglessScript/element-nivris nivris-uninstall
status=$?

echo
if [ $status -eq 0 ]; then
    echo "Xong! Tat han Element (Cmd+Q) roi mo lai."
else
    echo "Go cai dat gap loi (xem chi tiet o tren)."
fi
echo
read -n 1 -s -r -p "Nhan phim bat ky de dong cua so nay..."
