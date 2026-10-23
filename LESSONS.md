# Lessons

<!-- One line per lesson: `- <lesson> | count: N | last: YYYY-MM-DD | applies: <where>`.
Written by kit-run from reviewer findings. The planner reads it before planning and
folds matching lessons into task blocks. At count >= 2 the planner schedules a task that promotes
the lesson to a lint rule, hook or test, and that task deletes the line. This file should shrink. -->

- For jobs that must never raise, end with a catch-all `except Exception` that logs and returns 1; listing specific exception types misses TypeError and AttributeError | count: 2 | last: 2026-10-23 | applies: `sync_once` / `poll_once`-style jobs
- When a PR adds a CI workflow, check that every tool it runs (e.g. pytest) is installed by the dependency files the workflow installs from | count: 1 | last: 2026-10-23 | applies: kit adoption / any task adding .github/workflows
