# AGENTS.md — rules for AI assistants working in this repo

- CHAT_PLANNER.md was written for a chat agent limited to GET-only fetches;
  the app may use more (POST etc.), but the semantic rules (§) remain binding.

## Process
- Do not commit: prepare minimal changes, show the diff and wait for the user; commit only on explicit request.
- Keep repo diffs minimal: touch only what the current task requires; refactors and cleanups only when asked.

## Code
- Good practices: self-describing code, design patterns only where necessary.

## Comments
- Only where necessary, concise, single line; justify the decision, not the obvious.
- In English, like all documentation.
