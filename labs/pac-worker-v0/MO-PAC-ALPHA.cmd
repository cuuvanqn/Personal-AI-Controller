@echo off
setlocal
title PAC Alpha - Worker Lab (chi du lieu mau)
powershell.exe -NoLogo -NoProfile -STA -File "%~dp0pac-alpha-ui.ps1"
if errorlevel 1 (
  echo Khong the mo giao dien. Hay kiem tra Windows PowerShell 5.1 va chinh sach script.
  echo Khong can chay voi quyen Administrator hoac tat PowerShell security policy.
  pause
)
endlocal
