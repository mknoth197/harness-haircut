# Public Sharing Blueprint: Agent Harness Superchargers

Use this as the foundation for documenting and publishing your multi-agent findings.

## 1) Publish by layer (not by provider)

Document once in shared layers, then map to provider harnesses:

- **Skills**: reusable tasks/workflows
- **Plugins**: integrations/tooling extensions
- **Methodologies**: operating patterns and decision frameworks
- **Provider Harnesses**: provider-specific adaptation (Claude/Codex/Copilot)

## 2) Keep a clear source of truth

- Put canonical logic in `/shared/*`
- Keep provider folders focused on adaptation only
- Cross-link every provider doc to the shared source files it uses

## 3) Standard public documentation pattern

For each shared asset, include:

1. **Problem solved**
2. **When to use**
3. **Inputs/outputs**
4. **Provider differences**
5. **Example usage**

## 4) Multi-provider optimization approach

- Avoid copy/paste prompt drift by centralizing reusable content in `/shared`
- Keep thin provider wrappers in `/harnesses/*`
- Maintain a single mapping file (example: `.harness/superchargers.yaml`) that maps provider -> shared assets

## 5) Suggested onboarding flow for external users

1. Copy starter scaffold from `/examples/multi-harness-starter`
2. Select active providers (Claude/Codex/Copilot)
3. Enable shared skills/plugins/methodologies
4. Override only provider-specific deltas

