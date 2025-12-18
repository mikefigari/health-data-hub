@echo on
echo RUN STARTED: %date% %time% >> "%~dp0oura_poller_debug.log"
echo Using THIS BAT FILE: %~f0 >> "%~dp0oura_poller_debug.log"

cd /d "%~dp0"

set "PYTHONPATH=%~dp0.."
echo PYTHONPATH=%PYTHONPATH% >> "%~dp0oura_poller_debug.log"

call "%~dp0venv\Scripts\activate.bat"
echo Activated venv. >> "%~dp0oura_poller_debug.log"

python --version >> "%~dp0oura_poller_debug.log" 2>&1
where python >> "%~dp0oura_poller_debug.log" 2>&1

echo Running poll_oura... >> "%~dp0oura_poller_debug.log"

rem Run as a module, unbuffered, so logs flush immediately
python -u -m health_data_hub.integrations.oura.poll_oura >> "%~dp0oura_poller_debug.log" 2>&1

echo Poller exited. >> "%~dp0oura_poller_debug.log"
echo %date% %time% >> "%~dp0oura_poller_debug.log"
