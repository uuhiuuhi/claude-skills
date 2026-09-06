# Project-pinned batch runtime

Copied from the installed `auto-story-finish` runtime on 2026-09-06, then adapted for this project's routing policy. The upstream pipeline SHA-256 before changes was `BDD5ECC215FCB5F6F1BB24A452DD9181BD03BD214B29F97DE75392D01F3553D2`.

This directory is versioned together with `tools/auto`. It is not a separately installable global skill: the pipeline also imports project assignment and runner rules. The entry point is `tools/auto/run-night.mjs`; skill instructions live in `.claude/skills/night-batch/SKILL.md`.

Do not overwrite this directory from a global skill update. Review upstream changes and run the regression tests before adopting them. The local resolver uses one runtime for both executable and helper modules; `AUTO_STORY_RUNTIME` is an explicit override and fails if a requested module is absent.
