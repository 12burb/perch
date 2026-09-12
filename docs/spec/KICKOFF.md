# Kickoff prompts

Paste one of these into your agent (Claude Code, Codex, OpenCode, Gemini CLI, or any ACP agent) from the
repo root after unpacking this kit and running `git init && git add -A && git commit -s -m "chore: perch agent kit"`.

## A. First run (Phase 0)

```
Read AGENTS.md, then docs/spec/PERCH-PLAN.md in full. This is a greenfield build of Perch.
Your queue is TASKS.md. Start with task 0.1 and work strictly in order; one task per PR.
Task 0.3 comes before any dependency is added anywhere: resolve exact package names and versions from
official docs, pin them, and record non-obvious picks in DECISIONS.md.
Run the Phase 0 spikes (spec §15.6) as their own PRs and record each outcome as an ADR.
Follow the workflow in AGENTS.md §2 for every task. Do not ask me questions; record defaults as ADRs.
Report back only when Phase 0 is fully checked in TASKS.md, with a summary of ADRs added and any spec
deviations.
```

## B. Resume (any later session)

```
Read AGENTS.md and TASKS.md. Continue from the first unchecked task whose prerequisites are checked.
If a task is marked [~], check whether its branch exists and resume it before starting anything new.
Same rules: one task per PR, tests first where testable, ADRs for anything not in the spec, no questions.
```

## C. Phase gate (before starting the next phase)

```
Audit the finished phase against docs/spec/PERCH-PLAN.md: for every task in TASKS.md marked [x], confirm the
acceptance criterion is demonstrated by a test or a documented command in the merged PR. List gaps as new
tasks at the top of the next phase in TASKS.md. Run the full Playwright suite and the compose smoke test on a
clean checkout. Then write the next phase's task list in TASKS.md from spec §8, §5.7, and §5.8, in the same
one-line-plus-acceptance format, and stop for my review before starting it.
```

## D. Single task (when you want to hand out one item)

```
Read AGENTS.md. Do task <ID> from TASKS.md only. Open one PR. Do not touch other tasks.
```
