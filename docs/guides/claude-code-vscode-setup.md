# Claude Code VS Code Extension Setup

Quick guide for installing and configuring the Claude Code extension in VS Code with the LiteLLM proxy. For full CLI installation, SSH setup, and project onboarding see [onboarding.md](onboarding.md).

## 1. Install the Extension

1. Open VS Code
2. Open the Extensions panel (`Cmd+Shift+X` on Mac / `Ctrl+Shift+X` on Windows)
3. Search for **Claude Code**
4. Install the extension by Anthropic (look for the verified publisher badge)

## 2. Configure VS Code Settings

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), search for **Preferences: Open User Settings (JSON)**, and add the following:

```json
{
  "claudeCode.preferredLocation": "panel",
  "claudeCode.disableLoginPrompt": true,
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "https://litellm.sandbox.starplatform.cloud" },
    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "<your-auth-token>" },
    { "name": "ANTHROPIC_DEFAULT_OPUS_MODEL", "value": "claude-opus-4-7" },
    { "name": "ANTHROPIC_DEFAULT_SONNET_MODEL", "value": "claude-sonnet-4-6" },
    { "name": "ANTHROPIC_DEFAULT_HAIKU_MODEL", "value": "claude-haiku-4-5" },
    { "name": "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "value": "1" }
  ]
}
```

> **Auth token:** Ask a project admin for your LiteLLM auth token. Never commit the token to the repository. For details on the environment variables, see [onboarding.md Section 4](onboarding.md#4-install-claude-code-cli).

### 2a. Protect the Token at Rest

VS Code stores `claudeCode.environmentVariables` in plain text inside `settings.json`. Treat that file like a credential file:

1. **Restrict file permissions** so only your user account can read it:

   ```bash
   # macOS / Linux
   chmod 600 "$HOME/Library/Application Support/Code/User/settings.json"
   ```

   ```powershell
   # Windows (PowerShell, run from your user profile)
   icacls "$env:APPDATA\Code\User\settings.json" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
   ```

2. **Disable VS Code Settings Sync for this file**, or scrub the token before syncing — Settings Sync uploads `settings.json` to your linked GitHub/Microsoft account by default. Open the Command Palette → **Settings Sync: Configure** → uncheck **Settings**, or move the token to a separate setting that Sync ignores.
3. **Do not screen-share or paste the contents** of `settings.json` in tickets, screenshots, or chat. The line containing `ANTHROPIC_AUTH_TOKEN` is the credential.
4. **Rotate the token** by asking a project admin if you suspect it has leaked, and remove it from any shell history (`history -d <line>` then `history -w` for zsh).

## 3. Verify Setup

1. **Restart VS Code** — fully quit (`Cmd+Q` / close all windows) and reopen. A window reload is not enough.
2. Click the Claude icon in the sidebar or open the panel via `Cmd+Shift+P` → **Claude Code: Open**
3. Check that the model selector shows available models (Sonnet, Opus, etc.)
4. Type a test message (e.g. `say hello`) and confirm Claude responds without a login prompt

## 4. Troubleshooting

| Problem | Fix |
|---------|-----|
| Login / onboarding screen still appears | Confirm `claudeCode.disableLoginPrompt: true` is in settings.json, then fully quit and restart VS Code |
| No models in the selector | Check that `ANTHROPIC_BASE_URL` is set and `ANTHROPIC_AUTH_TOKEN` is not empty |
| 401 auth error | Double-check your `ANTHROPIC_AUTH_TOKEN` value — no extra spaces or quotes |
| Claude opens in sidebar instead of panel | Set `"claudeCode.preferredLocation": "panel"` in settings.json and restart VS Code |
| Extension not found in marketplace | Search for `Claude Code` (two words) and ensure your VS Code is version 1.98+ |

## See also

- [onboarding.md](onboarding.md) — Full onboarding guide (CLI install, SSH, stack bootstrap)
- [ace-plugin-installation.md](ace-plugin-installation.md) — Optional: ACE plugin for BriefingPack integration
