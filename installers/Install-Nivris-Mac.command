#!/bin/bash
# Double-click this file in Finder to install N.I.V.R.I.S. into Element Desktop.
# (First run: right-click -> Open, since macOS blocks unsigned scripts by default.)
cd "$(dirname "$0")" || exit 1

echo "===================================="
echo " N.I.V.R.I.S. - Cai dat cho Element"
echo "===================================="
echo

if ! command -v npx >/dev/null 2>&1; then
    echo "Chua tim thay Node.js tren may nay."
    echo "Buoc 1: Cai Node.js (ban LTS) tai https://nodejs.org"
    echo "Buoc 2: Sau khi cai xong, chay lai file nay."
    echo
    read -n 1 -s -r -p "Nhan phim bat ky de dong cua so nay..."
    exit 1
fi

npx -y -p github:StinglessScript/element-nivris nivris-install
status=$?

echo
if [ $status -eq 0 ]; then
    echo "Xong! Tat han Element (Cmd+Q, khong chi dong cua so) roi mo lai de thay N.I.V.R.I.S."
else
    echo "Cai dat gap loi (xem chi tiet o tren). Neu la loi quyen ghi vao /Applications,"
    echo "lam theo huong dan trong thong bao loi roi chay lai file nay."
fi
echo
read -n 1 -s -r -p "Nhan phim bat ky de dong cua so nay..."
