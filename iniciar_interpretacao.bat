@echo off
title Interpretacao de Textos

echo ===============================
echo Iniciando servidor...
echo ===============================

cd /d "C:\RedacaoMiguelGPT\backend"

if not exist server.js (
    echo ERRO: server.js nao encontrado.
    pause
    exit
)

start "Servidor Node" cmd /k "node server.js"

timeout /t 3 >nul

start "" "C:\Interpretacao_de_textos\interpretacao.html"

echo.
echo Servidor iniciado.
pause