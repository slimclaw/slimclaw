---
name: github
description: Interact with GitHub repositories, issues, and pull requests
always: false
requires:
  bins: [gh]
---

## Instructions
When the user asks about GitHub repositories, issues, or pull requests, use the bash tool
with the `gh` CLI to fetch information. Common commands:

- `gh repo view <owner/repo>` — view repo details
- `gh issue list -R <owner/repo>` — list issues
- `gh pr list -R <owner/repo>` — list pull requests
- `gh issue view <number> -R <owner/repo>` — view a specific issue

Always confirm the repository name with the user if ambiguous.
