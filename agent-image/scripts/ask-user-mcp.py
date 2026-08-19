#!/usr/bin/env python3
"""Bundled stdio MCP server that exposes an ``AskUserQuestion`` tool to headless
agent runs (#1712).

Claude Code's *built-in* ``AskUserQuestion`` tool is an interactive-TTY-only
tool: in ``-p`` / print mode (how every agent turn runs — a single
non-interactive process with stdin closed) the CLI removes it from the model's
tool set entirely, so the model can never emit it and the #447 intercept + #1663
quick-reply UI never fire. Adding it to ``--allowedTools`` / ``--tools`` does not
help — the tool is filtered before permissions are ever consulted.

This tiny, dependency-free stdio MCP server re-supplies an ``AskUserQuestion``
tool with the **same input shape** the built-in one uses (``questions[]`` with
``header`` / ``question`` / ``options[].{label,description}`` / ``multiSelect``),
so the runner can offer it via ``--mcp-config``. When the model calls it the
tool_use appears in the stream as ``mcp__aee-ask__AskUserQuestion``; the runner
(``agent-entrypoint.py``) intercepts that tool_use, renders the question into the
central chat (#447) with the structured quick-reply payload (#1663), and the run
ends — pausing for the human, whose next chat message resumes the session.

The tool itself returns a short instruction telling the model to end its turn and
wait, so the turn completes cleanly (``result`` is a normal success, the session
stays coherent for ``--resume``) instead of erroring out. It deliberately holds
no state and talks to nothing — all of the rendering / pausing lives in the
runner, exactly as the built-in tool's intercept did.

Protocol: JSON-RPC 2.0 over newline-delimited stdin/stdout (MCP stdio
transport). Only the handful of methods a print-mode CLI actually calls are
implemented; unknown requests get a JSON-RPC error, notifications are ignored.
"""
from __future__ import annotations

import json
import sys

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "aee-ask"
TOOL_NAME = "AskUserQuestion"

# The reply handed back to the model after it asks. It is never shown to the
# human (the runner posts the rendered question instead); its only job is to make
# the model stop and wait rather than answer its own question or keep working.
_ANSWER_STUB = (
    "Your question has been delivered to the user and the run is now paused. "
    "END YOUR TURN NOW — do not answer it yourself, and do not take any further "
    "action. The user's reply will arrive as your next message, at which point "
    "you can continue where you left off."
)

TOOL = {
    "name": TOOL_NAME,
    "description": (
        "Ask the human user one or more structured multiple-choice questions and "
        "PAUSE the run until they answer. Use this whenever you need the user to "
        "make a choice or clarify something before you can continue — instead of "
        "writing the options out as plain text. Each question renders in the chat "
        "as clickable option buttons. After calling this tool, stop and wait: the "
        "user's answer arrives as your next message."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "description": "One or more questions to put to the user.",
                "items": {
                    "type": "object",
                    "properties": {
                        "header": {
                            "type": "string",
                            "description": "Short label/category for the question.",
                        },
                        "question": {
                            "type": "string",
                            "description": "The question text shown to the user.",
                        },
                        "options": {
                            "type": "array",
                            "description": "The choices offered for this question.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {
                                        "type": "string",
                                        "description": "The option text (also the "
                                        "reply sent when the user picks it).",
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "Optional longer explanation "
                                        "of the option.",
                                    },
                                },
                                "required": ["label"],
                            },
                        },
                        "multiSelect": {
                            "type": "boolean",
                            "description": "Whether the user may pick more than one "
                            "option.",
                        },
                    },
                    "required": ["question", "options"],
                },
            }
        },
        "required": ["questions"],
    },
}


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _result(req_id, result: dict) -> None:
    _send({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id, code: int, message: str) -> None:
    _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def _handle(req: dict) -> None:
    method = req.get("method")
    req_id = req.get("id")

    if method == "initialize":
        _result(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": "1.0.0"},
        })
    elif method == "tools/list":
        _result(req_id, {"tools": [TOOL]})
    elif method == "tools/call":
        # The runner intercepts the tool_use from the stream; this reply only has
        # to make the model stop and wait. Shape it as an ordinary (non-error)
        # tool result so the turn ends as a success and the session stays
        # resumable.
        _result(req_id, {"content": [{"type": "text", "text": _ANSWER_STUB}]})
    elif method == "ping":
        _result(req_id, {})
    elif req_id is not None:
        # A request (has an id) we don't implement — answer with a JSON-RPC error
        # rather than going silent, so the CLI doesn't hang waiting.
        _error(req_id, -32601, f"method not found: {method}")
    # else: a notification (no id, e.g. notifications/initialized) — ignore.


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(req, dict):
            try:
                _handle(req)
            except Exception:  # a broker tool must never crash the transport
                rid = req.get("id") if isinstance(req, dict) else None
                if rid is not None:
                    _error(rid, -32603, "internal error")
    return 0


if __name__ == "__main__":
    sys.exit(main())
