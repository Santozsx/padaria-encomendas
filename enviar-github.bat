@echo off
setlocal
title Enviar projeto para o GitHub
cd /d "%~dp0"

rem =====================================================================
rem  Envia esta pasta para https://github.com/Santozsx/padaria-encomendas
rem  O arquivo backend\.env (com as chaves) NUNCA vai junto (.gitignore).
rem =====================================================================

where git >nul 2>nul
if errorlevel 1 (
  echo [ERRO] O Git nao esta instalado.
  echo  Instale em https://git-scm.com/download/win - pode aceitar tudo no padrao -
  echo  e depois rode este arquivo de novo.
  start https://git-scm.com/download/win
  pause
  exit /b 1
)

if not exist ".git" git init -b main

rem nome e e-mail do autor (so se ainda nao estiverem configurados)
git config user.name >nul 2>nul || git config user.name "Gabriel Rodrigues"
git config user.email >nul 2>nul || git config user.email "Santozsx@users.noreply.github.com"

git add -A

rem trava de seguranca: o .env com as chaves nao pode ir para o GitHub
git ls-files --cached | findstr /r /c:"\.env$" >nul
if not errorlevel 1 (
  echo [ERRO] O arquivo .env entrou na lista de envio. Nada foi enviado.
  git ls-files --cached | findstr /r /c:"\.env$"
  pause
  exit /b 1
)

rem descreva a mudanca: aparece no historico do GitHub e na Render (ajuda a desfazer)
set "MSG="
echo.
set /p "MSG=O que mudou nesta atualizacao? (Enter = Atualizacao do sistema): "
if not defined MSG set "MSG=Atualizacao do sistema"
set "MSG=%MSG:"=%"
git commit -m "%MSG%" >nul 2>nul
if errorlevel 1 echo  (nada novo para gravar - so conferindo o envio)
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/Santozsx/padaria-encomendas.git

echo.
echo Enviando... se abrir uma janela do GitHub, faca login e autorize.
echo.
git push -u origin main
if errorlevel 1 (
  echo.
  echo [ERRO] O envio falhou. Veja a mensagem acima.
  pause
  exit /b 1
)
echo.
echo ==============================================
echo  Pronto! https://github.com/Santozsx/padaria-encomendas
echo ==============================================
pause
