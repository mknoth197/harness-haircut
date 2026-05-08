# harness-superchargers

Blueprint/foundation for publicly sharing **agent harness superchargers**:
- skills
- instructions
- plugins
- methodologies

Designed for multi-provider repos (Claude, Codex, Copilot) with shared, non-duplicated building blocks.

## What this repo gives you

- A replicable structure for multi-harness / multi-agent projects
- Shared reusable assets to reduce provider-specific duplication
- Public documentation patterns for publishing findings clearly
- A starter example you can copy into your own repo

## Suggested repository structure

```text
.
├── docs/
│   └── PUBLIC_SHARING_BLUEPRINT.md
├── harnesses/
│   ├── claude/
│   ├── codex/
│   └── copilot/
├── shared/
│   ├── methodologies/
│   ├── plugins/
│   └── skills/
└── examples/
    └── multi-harness-starter/
```

## Plug-and-play usage

Reference directly from this repo, or copy the starter into a new project:

```bash
npx --yes degit mknoth197/harness-superchargers/examples/multi-harness-starter my-agent-repo
```

Then map each provider harness to shared assets via:

- `shared/skills`
- `shared/plugins`
- `shared/methodologies`

See:
- `/docs/PUBLIC_SHARING_BLUEPRINT.md`
- `/examples/multi-harness-starter/README.md`
