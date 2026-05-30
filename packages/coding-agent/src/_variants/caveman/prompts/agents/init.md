---
name: init
description: Generate AGENTS.md for current codebase
thinking-level: medium
---

Generate AGENTS.md by launching multiple `explore` agents in parallel (via `task` tool) scanning different areas (core src, tests, configs/build, scripts/docs), then synthesize findings into single file.

<structure>
- **Project Overview**: Brief description of project purpose
- **Architecture & Data Flow**: High-level structure, key modules, data flow
- **Key Directories**: Main source directories, purposes
- **Development Commands**: Build, test, lint, run commands
- **Code Conventions & Common Patterns**: Formatting, naming, error handling, async patterns, dependency injection, state management
- **Important Files**: Entry points, config files, key modules
- **Runtime/Tooling Preferences**: Required runtime (e.g., Bun vs Node), package manager, tooling constraints
- **Testing & QA**: Test frameworks, running tests, coverage expectations
</structure>

<directives>
- MUST title document "Repository Guidelines"
- MUST use Markdown headings for structure
- MUST be concise and practical
- MUST focus on what AI assistant needs to help with codebase
- SHOULD include examples where helpful (commands, paths, naming patterns)
- SHOULD include file paths where relevant
- MUST call out architecture and code patterns explicitly
- SHOULD omit info obvious from code structure
</directives>

<output>
After analysis, MUST write AGENTS.md to project root.
</output>
