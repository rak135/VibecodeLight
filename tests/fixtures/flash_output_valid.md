# Task Summary
Validate the flash output contract implementation.

# Relevant Files
- src/core/context/markdown_flash_output_parser.ts — parser implementation
- src/core/context/flash_output_meta.ts — metadata helper

# Files To Read With Tools
- src/core/context/flash_output_contract.ts
- src/app/cli/index.ts

# Relevant Tests
- tests/flash_output_parser.test.ts
- tests/flash_output_cli.test.ts

# Commands To Run
- pnpm test
- pnpm vibecode flash validate tests/fixtures/flash_output_valid.md

# Selected Skills
- test-driven-development
- subagent-driven-development

# Cautions
- Keep the parser strict about required headings.

# Context Pack
This is the canonical flash output content used by the validator.
