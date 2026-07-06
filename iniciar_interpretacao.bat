@echo off
title Interpretacao de Textos

echo ===============================
echo Iniciando servidor...
echo ===============================

cd /d "%~dp0"

if not exist package.json (
    echo ERRO: package.json nao encontrado.
    pause
    exit
)

if not exist node_modules (
    echo Instalando dependencias...
    npm install
)

start "Interpretacao Backend" cmd /k "npm start"

timeout /t 3 >nul

start "" "http://localhost:3000/index.html"

echo.
echo Servidor iniciado.
pause
