@echo off
setlocal EnableExtensions
title Padaria - Sistema de Encomendas
cd /d "%~dp0"

rem =====================================================================
rem  Padaria - Sistema de Encomendas
rem  De dois cliques neste arquivo para abrir o menu.
rem =====================================================================

rem ---------- 1. Node.js instalado? ----------
where node >nul 2>nul
if errorlevel 1 goto :sem_node

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODEV=%%v"
set "NODEV=%NODEV:v=%"
if %NODEV% LSS 20 goto :node_antigo

rem ---------- 2. Arquivo .env existe e esta preenchido? ----------
if not exist "backend\.env" goto :criar_env
findstr /c:"SEU-PROJETO" "backend\.env" >nul 2>nul
if not errorlevel 1 goto :env_incompleto

rem ---------- 3. Dependencias do back-end ----------
if exist "backend\node_modules" goto :ler_porta
echo.
echo Instalando dependencias do servidor (so na primeira vez)...
pushd backend
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  echo.
  echo [ERRO] Falha no npm install. Verifique sua internet e tente de novo.
  pause
  exit /b 1
)
popd

:ler_porta
set "PORT=3000"
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"PORT=" "backend\.env"`) do set "PORT=%%b"
set "PORT=%PORT: =%"

rem =====================================================================
:menu
cls
echo  ==============================================
echo     PADARIA - SISTEMA DE ENCOMENDAS
echo  ==============================================
echo.
echo   [1] Iniciar o sistema (abre as telas no navegador)
echo   [2] Iniciar o sistema sem abrir o navegador
echo   [3] Criar usuario da equipe
echo   [4] Rodar os testes
echo   [5] Gerar APK da cozinha (precisa do Android Studio)
echo   [6] Editar configuracoes (.env)
echo   [7] Definir dono do sistema (acesso ao Painel do sistema)
echo   [8] Liberar a TV / celular no firewall do Windows (porta %PORT%)
echo   [0] Sair
echo.
set "OP="
set /p "OP=Escolha uma opcao e tecle ENTER: "
if "%OP%"=="1" goto :iniciar_abrir
if "%OP%"=="2" goto :iniciar
if "%OP%"=="3" goto :criar_usuario
if "%OP%"=="4" goto :testes
if "%OP%"=="5" goto :apk
if "%OP%"=="6" goto :editar_env
if "%OP%"=="7" goto :dono_sistema
if "%OP%"=="8" goto :firewall
if "%OP%"=="0" exit /b 0
goto :menu

rem =====================================================================
:iniciar_abrir
rem abre as 3 telas alguns segundos depois, enquanto o servidor sobe
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:%PORT%/loja/padaria-bela-vista & start http://localhost:%PORT%/atendimento & start http://localhost:%PORT%/cozinha/"

:iniciar
cls
echo  ==============================================
echo   Servidor rodando. NAO feche esta janela.
echo  ==============================================
echo.
echo   Inicio ............: http://localhost:%PORT%/
echo   Loja (clientes) ...: http://localhost:%PORT%/loja/padaria-bela-vista
echo   Atendimento .......: http://localhost:%PORT%/atendimento
echo   Cozinha ...........: http://localhost:%PORT%/cozinha/
echo   Painel do sistema .: http://localhost:%PORT%/plataforma
echo.
echo   Outros aparelhos da mesma rede (celular, TV):
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do call :mostrar_ip %%i
echo.
echo   Para parar: CTRL + C e depois S.
echo  ----------------------------------------------
echo.
pushd backend
call npm start
popd
echo.
echo O servidor foi encerrado.
pause
goto :menu

:mostrar_ip
echo     http://%1:%PORT%/
exit /b 0

rem =====================================================================
:criar_usuario
cls
echo  ===== Criar usuario da equipe =====
echo.
echo  Papeis:  admin  /  atendimento  /  cozinha
echo  Loja: o final do link da loja. Ex.: em /loja/padaria-bela-vista
echo        a loja e  padaria-bela-vista  (ENTER usa essa).
echo  Dica: lojas novas sao cadastradas no Painel do sistema (/plataforma).
echo  (evite o caractere %% na senha)
echo.
set "U_EMAIL="
set "U_SENHA="
set "U_NOME="
set "U_PAPEL="
set "U_LOJA="
set /p "U_EMAIL=E-mail ......: "
set /p "U_SENHA=Senha (min. 8): "
set /p "U_NOME=Nome ........: "
set /p "U_PAPEL=Papel .......: "
set /p "U_LOJA=Loja ........: "
if "%U_LOJA%"=="" set "U_LOJA=padaria-bela-vista"
if "%U_EMAIL%"=="" goto :faltou_dado
if "%U_SENHA%"=="" goto :faltou_dado
if "%U_NOME%"=="" goto :faltou_dado
if "%U_PAPEL%"=="" goto :faltou_dado
echo.
pushd backend
call npm run --silent staff:create -- --email "%U_EMAIL%" --password "%U_SENHA%" --name "%U_NOME%" --role "%U_PAPEL%" --store "%U_LOJA%"
popd
echo.
pause
goto :menu

:faltou_dado
echo.
echo [AVISO] Preencha todos os campos.
pause
goto :menu

rem =====================================================================
:dono_sistema
cls
echo  ===== Definir dono do sistema =====
echo.
echo  O dono do sistema entra em http://localhost:%PORT%/plataforma
echo  e cadastra os estabelecimentos (nome, CNPJ/CPF, endereco, telefone).
echo  A conta precisa existir antes (crie pela opcao 3, se precisar).
echo.
set "D_EMAIL="
set /p "D_EMAIL=E-mail da sua conta: "
if "%D_EMAIL%"=="" goto :faltou_dado
echo.
pushd backend
call npm run --silent platform:admin -- --email "%D_EMAIL%"
popd
echo.
pause
goto :menu

rem =====================================================================
:firewall
cls
echo  ===== Liberar a porta %PORT% no firewall =====
echo.
echo  Isso deixa a TV e os celulares da mesma rede acessarem o sistema.
echo  O Windows vai pedir permissao de administrador: clique em SIM.
echo.
powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name=Padaria-%PORT% dir=in action=allow protocol=TCP localport=%PORT%'"
if errorlevel 1 (
  echo [AVISO] A permissao foi negada ou deu erro. Tente de novo.
) else (
  echo  Pronto: porta %PORT% liberada.
)
echo.
pause
goto :menu

rem =====================================================================
:testes
cls
pushd backend
call npm test
popd
echo.
pause
goto :menu

rem =====================================================================
:apk
cls
echo  ===== Gerar APK da cozinha (debug) =====
echo.
rem Usa o SDK e o Java 21 que vem com o Android Studio (evita Javas antigos instalados por outros programas)
if not defined ANDROID_HOME if defined ANDROID_SDK_ROOT set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
if not defined ANDROID_HOME if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%LOCALAPPDATA%\Programs\Android Studio\jbr"
if defined ANDROID_HOME echo  Android SDK: %ANDROID_HOME%
if defined JAVA_HOME echo  Java ......: %JAVA_HOME%
echo.
if not defined ANDROID_HOME if not defined ANDROID_SDK_ROOT (
  echo [ERRO] Android SDK nao encontrado.
  echo  Instale o Android Studio e crie a variavel de ambiente ANDROID_HOME
  echo  apontando para a pasta do SDK - normalmente:
  echo  %LOCALAPPDATA%\Android\Sdk
  echo.
  pause
  goto :menu
)
where java >nul 2>nul
if errorlevel 1 if not defined JAVA_HOME (
  echo [ERRO] Java - JDK 21 - nao encontrado. Ele vem junto com o Android Studio:
  echo  crie JAVA_HOME apontando para "C:\Program Files\Android\Android Studio\jbr"
  echo.
  pause
  goto :menu
)

pushd kitchen-app
if not exist "node_modules" (
  echo Instalando dependencias do app da cozinha...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :apk_erro
)
if not exist "android" (
  echo Criando projeto Android...
  call npm run android:add
  if errorlevel 1 goto :apk_erro
) else (
  call npm run android:sync
  if errorlevel 1 goto :apk_erro
)
pushd android
call gradlew.bat assembleDebug
if errorlevel 1 (
  popd
  goto :apk_erro
)
popd
popd
echo.
echo  ==============================================
echo   APK gerado com sucesso:
echo   kitchen-app\android\app\build\outputs\apk\debug\app-debug.apk
echo  ==============================================
explorer "kitchen-app\android\app\build\outputs\apk\debug"
pause
goto :menu

:apk_erro
popd
echo.
echo [ERRO] Nao foi possivel gerar o APK. Veja as mensagens acima.
echo  Dicas: na primeira vez o Gradle baixa varios arquivos - precisa de internet.
echo  Se aparecer "Unsupported class file" ou "invalid source release: 21",
echo  atualize o Android Studio - o projeto precisa do Java 21.
pause
goto :menu

rem =====================================================================
:editar_env
notepad "backend\.env"
goto :ler_porta

rem =====================================================================
:criar_env
copy /y "backend\.env.example" "backend\.env" >nul
echo.
echo  ==============================================
echo   Primeira execucao: arquivo de configuracao criado.
echo  ==============================================
echo.
echo  O Bloco de Notas vai abrir. Preencha com os dados do Supabase
echo  (Project Settings - API):
echo    SUPABASE_URL
echo    SUPABASE_ANON_KEY
echo    SUPABASE_SERVICE_ROLE_KEY
echo.
echo  Salve, feche o Bloco de Notas e rode este arquivo de novo.
echo.
pause
notepad "backend\.env"
exit /b 0

:env_incompleto
echo.
echo [AVISO] O arquivo backend\.env ainda tem valores de exemplo.
echo         Preencha com os dados do seu projeto Supabase.
echo.
pause
notepad "backend\.env"
exit /b 0

:sem_node
echo.
echo [ERRO] Node.js nao encontrado.
echo  Instale a versao LTS em https://nodejs.org e rode este arquivo de novo.
echo.
start https://nodejs.org/pt-br/download
pause
exit /b 1

:node_antigo
echo.
echo [ERRO] Seu Node.js e muito antigo - versao %NODEV%.
echo  Instale a versao LTS 22 em https://nodejs.org
echo.
pause
exit /b 1
