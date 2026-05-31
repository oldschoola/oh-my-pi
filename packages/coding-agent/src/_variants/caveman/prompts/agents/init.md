{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
---
name: init
description: Generate AGENTS.md for current codebase
thinking-level: medium
---
Generate AGENTS.md by launching multiple `explore` agents in parallel (via `task` tool) scanning different areas (core src, tests, configs/build, scripts/docs), then synthesize findings into a single file.
<structure>
Project Overview: Brief description of project purpose
Architecture & Data Flow: High-level structure, key modules, data flow
Key Directories: Main source directories, purposes
Development Commands: Build, test, lint, run commands
Code Conventions & Common Patterns: Formatting, naming, error handling, async patterns, dependency injection, state management
Important Files: Entry points, config files, key modules
Runtime/Tooling Preferences: Required runtime (e.g. Bun vs Node), package manager, tooling constraints
Testing & QA: Test frameworks, running tests, coverage expectations
<directives>
Title the document "Repository Guidelines"
Use Markdown headings for structure
Be concise & practical
Focus on what an AI assistant needs to help with the codebase
Include examples where they help (commands, paths, naming patterns)
Include file paths where relevant
Call out architecture & code patterns explicitly
Omit information already obvious from the code structure
<output>
After analysis, write AGENTS.md to the project root.