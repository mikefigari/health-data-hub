@echo on
echo Starting poll script...

REM ensure PYTHONPATH points to project root FIRST
set PYTHONPATH=%~dp0

echo PYTHONPATH set to: %PYTHONPATH%

REM activate venv AFTER setting pythonpath
call "%~dp0venv\Scripts\activate.bat"

REM confirm python
python --version

echo Running poll_strava...
python "%~dp0integrations\poll_strava.py"

echo Script finished.
pause
