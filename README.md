# Enterprise Claude Bridge

Matrix-to-Claude-Code bridge for local operation with Podman. Provides a chat-based AI assistant that can be extended with domain-specific skills.

## Prerequisites

- Podman with `podman compose` (or `podman-compose`)
- An Anthropic API key configured for Claude Code (the CLI authenticates separately)

## Setup

### 1. Start the Matrix server

```bash
cd enterprise
podman compose up -d conduwuit
```

### 2. Create Matrix users

```bash
# Create the bot user
podman exec conduwuit conduwuit-admin users create-user claude <password>

# Create your own user
podman exec conduwuit conduwuit-admin users create-user <username> <password>
```

### 3. Obtain an access token for the bot

Log in as the bot user to get an access token:

```bash
curl -s -X POST http://localhost:8448/_matrix/client/v3/login \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"claude","password":"<password>"}' \
  | python3 -m json.tool
```

Copy the `access_token` from the response.

### 4. Create a room

Log in with your own user via a Matrix client (e.g. Element, pointing at `http://localhost:8448`) and create a room. Invite `@claude:local`. Note the room ID.

### 5. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in MATRIX_ACCESS_TOKEN and MATRIX_DEFAULT_ROOM
```

### 6. Start the bridge

```bash
podman compose up -d --build
```

## Adding Skills

Create a directory under `skills/` (inside the workspace volume) with a `SKILL.md` file, then add an entry to the skills table in the workspace `CLAUDE.md`.

## Logs

```bash
podman compose logs -f claude-bridge
podman compose logs -f conduwuit
```
