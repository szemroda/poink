---
name: poink-semantic-search
description: Build and query local document knowledge bases with semantic and hybrid search across PDF, Markdown, TXT, DOCX, ODT, and FODT files. Use when searching, ingesting, organizing, or inspecting documents with the poink CLI.
metadata:
  openclaw:
    requires:
      bins:
        - poink
    install:
      - kind: node
        package: poink-cli
        bins:
          - poink
    homepage: https://github.com/szemroda/poink
---

# Poink

- `poink capabilities --format json` provides the current agent-optimized CLI contract.
- Use `--format json` when executing `poink` non-interactive commands yourself.
- Prefer the default text output or `--format text` when suggesting commands for user to run.
- The [poink README](https://github.com/szemroda/poink#readme) documents installation and usage.
