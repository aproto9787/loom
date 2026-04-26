# Security Policy

## Supported versions

Security fixes are applied on the current `master` branch only.

## Reporting a vulnerability

Do not report vulnerabilities in public GitHub issues, pull requests, or discussions.

Use GitHub Private Vulnerability Reporting or a GitHub security advisory draft for this repository instead:

1. Open the repository's `Security` tab.
2. Start a private vulnerability report or private advisory draft.
3. Include reproduction steps, impact, affected commit or version, and any proof-of-concept details needed to validate the issue.

If private advisory reporting is not available, contact the maintainer through
the GitHub profile linked from the repository owner and avoid sharing
proof-of-concept details publicly until a private channel is established.

## What to report

Please report vulnerabilities that could affect users, contributors, or maintainers, including:

- Remote code execution, arbitrary command execution, or privilege escalation in the CLI, server, studio, adapters, or runtime.
- Sandbox escapes, bypass-permission flows, approval bypasses, or other paths that break intended execution boundaries.
- Secret exposure, credential leakage, or prompt-injection paths that can exfiltrate repository, system, or user data.
- Cross-user data access, authentication or authorization failures, or unsafe filesystem access.
- Supply chain risks introduced through dependency handling, update flows, or generated code execution.

## Disclosure expectations

- Give maintainers reasonable time to investigate and prepare a fix before public disclosure.
- Share only the minimum proof-of-concept needed to reproduce the issue safely.
- Do not access, modify, or destroy data beyond what is necessary to demonstrate the problem.
