# Security Policy

## Supported Versions

SpecMarten is pre-1.0 software. Security fixes target the latest `main` branch and the latest published npm version once publishing begins.

## Reporting A Vulnerability

Do not include exploit details in a public issue.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not available, open a minimal public issue that asks for a private contact path and omit sensitive details until a private channel is established.

Please include:

- affected SpecMarten version or commit
- operating system and Node.js version
- whether the issue affects the CLI, generated files, hooks, or CI examples
- minimal reproduction steps
- expected and actual impact

## Scope

In scope:

- arbitrary file writes outside the documented SpecMarten paths
- command injection in CLI arguments, hooks, or generated integration files
- unsafe handling of model output that bypasses schema validation
- package installation or release-chain issues

## Headless Trust Boundary

SpecMarten headless mode is bring-your-own-agent automation. It passes repository context and SpecMarten instructions to an installed local agent CLI, so untrusted repository content can try to influence that agent through prompt injection. This trust boundary is inherent to headless BYO-agent execution and is not a SpecMarten code vulnerability by itself.

Run headless mode only in trusted repositories or in isolated, disposable runners. For CI on untrusted pull requests, prefer deterministic checks such as `specmarten validate` and `specmarten reconcile`; if semantic headless checks are required, use least-privilege credentials, restrict secrets and network access, and keep human review before accepting generated state changes.

Out of scope:

- vulnerabilities in unrelated user projects where SpecMarten is only installed
- issues that require editing generated files by hand
- social engineering, spam, or denial-of-service reports without a concrete product impact
