"""AEEBridge — HTTP client for the AEE (Agent Execution Environment) orchestrator."""

from __future__ import annotations

import json
from typing import AsyncIterator

import aiohttp


class AEEBridge:
    """Encapsulates all HTTP calls to the AEE orchestrator."""

    def __init__(self, orchestrator_url: str) -> None:
        self._url = orchestrator_url.rstrip("/")
        self._session: aiohttp.ClientSession | None = None

    def _get_session(self) -> aiohttp.ClientSession:
        """Lazy session creation — creates a new session if none exists or it is closed."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        """Close the underlying HTTP session."""
        if self._session is not None and not self._session.closed:
            await self._session.close()

    async def is_available(self) -> bool:
        """Return True if the orchestrator responds with HTTP 200 on GET /internal/agents."""
        try:
            session = self._get_session()
            async with session.get(f"{self._url}/internal/agents") as resp:
                return resp.status == 200
        except Exception:
            return False

    async def create_ephemeral_agent(
        self,
        *,
        display_name: str,
        mission_prompt: str,
        environment_id: str,
        blueprint_id: str | None = None,
        timeout_seconds: int = 3600,
    ) -> str:
        """Create an ephemeral agent and return its agentId."""
        payload: dict = {
            "displayName": display_name,
            "missionPrompt": mission_prompt,
            "environmentId": environment_id,
            "timeoutSeconds": timeout_seconds,
        }
        if blueprint_id is not None:
            payload["blueprintId"] = blueprint_id

        session = self._get_session()
        async with session.post(
            f"{self._url}/internal/agents/ephemeral",
            json=payload,
        ) as resp:
            if not (200 <= resp.status < 300):
                body = await resp.text()
                raise Exception(f"HTTP {resp.status}: {body}")
            data = await resp.json()
        return data["agentId"]

    async def poll_agent(self, agent_id: str) -> dict:
        """Poll the agent status and return the full response JSON."""
        session = self._get_session()
        async with session.get(f"{self._url}/internal/agents/{agent_id}/poll") as resp:
            if not (200 <= resp.status < 300):
                body = await resp.text()
                raise Exception(f"HTTP {resp.status}: {body}")
            return await resp.json()

    async def stream_session_tail(
        self, agent_id: str, *, since: int = 0
    ) -> AsyncIterator[dict]:
        """Stream session-tail lines as parsed JSON dicts."""
        session = self._get_session()
        async with session.get(
            f"{self._url}/internal/agents/{agent_id}/session-tail",
            params={"since": since},
        ) as resp:
            if not (200 <= resp.status < 300):
                body = await resp.text()
                raise Exception(f"HTTP {resp.status}: {body}")
            async for raw_line in resp.content:
                line = raw_line.decode("utf-8").strip()
                if line:
                    yield json.loads(line)

    async def delete_agent(self, agent_id: str) -> None:
        """Delete an agent by ID."""
        session = self._get_session()
        async with session.delete(f"{self._url}/internal/agents/{agent_id}") as resp:
            if not (200 <= resp.status < 300):
                body = await resp.text()
                raise Exception(f"HTTP {resp.status}: {body}")

    async def get_blueprint_memory(self, blueprint_id: str, filename: str) -> str:
        """Fetch the content of a blueprint memory file."""
        session = self._get_session()
        async with session.get(
            f"{self._url}/internal/blueprints/{blueprint_id}/memory/{filename}"
        ) as resp:
            if not (200 <= resp.status < 300):
                body = await resp.text()
                raise Exception(f"HTTP {resp.status}: {body}")
            return await resp.text()

    async def put_blueprint_memory(
        self, blueprint_id: str, filename: str, content: str
    ) -> None:
        """Write a blueprint memory file."""
        session = self._get_session()
        async with session.put(
            f"{self._url}/internal/blueprints/{blueprint_id}/memory/{filename}",
            data=content.encode("utf-8"),
            headers={"Content-Type": "text/plain"},
        ) as resp:
            if not (200 <= resp.status < 300):
                body = await resp.text()
                raise Exception(f"HTTP {resp.status}: {body}")
