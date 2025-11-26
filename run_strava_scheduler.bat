@echo on
echo RUN STARTED: %date% %time% >> "%~dp0poller_debug.log"
echo Using THIS BAT FILE: %~f0 >> "%~dp0poller_debug.log"

cd /d "%~dp0"

set "PYTHONPATH=%~dp0.."
echo PYTHONPATH=%PYTHONPATH% >> "%~dp0poller_debug.log"

call "%~dp0venv\Scripts\activate.bat"
echo Activated venv. >> "%~dp0poller_debug.log"

python --version >> "%~dp0poller_debug.log" 2>&1
where python >> "%~dp0poller_debug.log" 2>&1

echo Running poll_strava... >> "%~dp0poller_debug.log"
python -m health_data_hub.integrations.poll_strava >> "%~dp0poller_debug.log" 2>&1

echo Poller exited. >> "%~dp0poller_debug.log"
echo %date% %time% >> "%~dp0poller_debug.log"
