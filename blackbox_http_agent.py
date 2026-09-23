"""
Blackbox HTTP agent adapter.

Adapts an externally deployed, black-box HTTP agent service (e.g. a
smart-cockpit assistant) to the tau2 half-duplex evaluation framework.

Design (ticket: .scratch/cockpit-eval/issues/01):
- Each user turn is forwarded as a single HTTP POST request (recommended
  stateful-session mode). Prior conversation history can optionally be sent
  via the ``history`` field.
- The caller is identified via ``user_id`` and ``vin`` request fields.
- The HTTP response (OpenAI-compatible message format preferred) is wrapped
  into a plain-text ``AssistantMessage`` with no tool calls, since all tool
  execution happens inside the black-box service.
- Structured action execution results found in the response (e.g.
  ``{"action": ..., "status": ...}``) are serialized into the AssistantMessage
  text. This is the only evidence downstream LLM judges can use to verify
  whether the black-box agent performed the right actions.
- HTTP failures and timeouts are converted into observable error messages
  instead of crashing the orchestrator.

Settings resolution order: ``llm_args`` (via ``--agent-llm-args``) >
environment variables (``BLACKBOX_HTTP_*``, see .env.example) >
``tau2.config`` defaults.
"""

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import requests
from dotenv import load_dotenv
from loguru import logger

from tau2.agent.base_agent import HalfDuplexAgent, is_valid_agent_history_message
from tau2.config import (
    DEFAULT_BLACKBOX_HTTP_BASE_URL,
    DEFAULT_BLACKBOX_HTTP_ENDPOINT,
    DEFAULT_BLACKBOX_HTTP_MAX_RETRIES,
    DEFAULT_BLACKBOX_HTTP_RETRY_BACKOFF_SECONDS,
    DEFAULT_BLACKBOX_HTTP_TIMEOUT,
)
from tau2.data_model.message import (
    AssistantMessage,
    Message,
    MultiToolMessage,
    ToolMessage,
    UserMessage,
)

load_dotenv()

ERROR_MARKER = "[BLACKBOX_HTTP_AGENT_ERROR]"

# Keys (checked in order) that may carry the assistant's reply text.
_TEXT_KEYS = ("content", "reply", "text", "response", "answer", "output", "message")

# Keys that may carry structured action/tool execution results. Anything found
# under these keys is serialized into the AssistantMessage text.
_ACTION_KEYS = (
    "actions",
    "action_results",
    "tool_calls",
    "tool_results",
    "tool_outputs",
    "function_call",
)


class BlackboxHTTPError(Exception):
    """Raised when the blackbox HTTP agent request fails permanently."""


@dataclass
class BlackboxHTTPAgentState:
    """Conversation state: OpenAI-compatible (role, content) turn history."""

    history: list[dict[str, str]] = field(default_factory=list)


def parse_blackbox_response(data: Any) -> tuple[str, list[Any], Optional[dict]]:
    """Parse a blackbox agent HTTP response body.

    Prefers the OpenAI-compatible format
    (``{"choices": [{"message": {"role": "assistant", "content": ...}}]}``),
    but also supports a bare message dict (``{"role": ..., "content": ...}``)
    and common single-field shapes (``{"reply": ...}`` etc.).

    Args:
        data: The parsed JSON response (any type).

    Returns:
        A tuple of (reply_text, action_payloads, usage). ``reply_text`` may be
        empty; ``action_payloads`` is a list of raw action objects (dicts or
        other JSON values); ``usage`` is the OpenAI-style usage dict if present.
    """
    if not isinstance(data, dict):
        if isinstance(data, str):
            return data, [], None
        return json.dumps(data, ensure_ascii=False, default=str), [], None

    usage = data.get("usage") if isinstance(data.get("usage"), dict) else None

    # Locate the OpenAI-style "message" object, if any.
    message: Optional[dict] = None
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        candidate = choices[0].get("message")
        if isinstance(candidate, dict):
            message = candidate
    if message is None and isinstance(data.get("message"), dict):
        message = data["message"]

    scopes = [message, data] if message is not None else [data]

    reply_text = ""
    for scope in scopes:
        if not isinstance(scope, dict):
            continue
        for key in _TEXT_KEYS:
            value = scope.get(key)
            if isinstance(value, str) and value.strip():
                reply_text = value.strip()
                break
        if reply_text:
            break

    actions: list[Any] = []
    for scope in scopes:
        if not isinstance(scope, dict):
            continue
        for key in _ACTION_KEYS:
            value = scope.get(key)
            if value is None or value == []:
                continue
            if isinstance(value, list):
                actions.extend(value)
            else:
                actions.append(value)

    if not reply_text and not actions and message is None:
        # Nothing recognized: surface the raw payload so the judge sees it.
        # (An empty reply from a *recognized* OpenAI-style message is returned
        # as-is so the caller can flag it as an empty response.)
        reply_text = json.dumps(data, ensure_ascii=False, default=str)

    return reply_text, actions, usage


def format_assistant_content(reply_text: str, actions: list[Any]) -> str:
    """Compose the final AssistantMessage text from reply and action results.

    Structured action results are serialized as JSON lines under a
    ``[Action results]`` header so they are visible to LLM judges.
    """
    parts: list[str] = []
    if reply_text and reply_text.strip():
        parts.append(reply_text.strip())
    if actions:
        parts.append("[Action results]")
        for action in actions:
            if isinstance(action, str):
                parts.append(action)
            else:
                parts.append(json.dumps(action, ensure_ascii=False, default=str))
    return "\n".join(parts)


class BlackboxHTTPAgent(HalfDuplexAgent[BlackboxHTTPAgentState]):
    """Half-duplex adapter for a deployed black-box HTTP agent service.

    Forwards each user message as a single HTTP POST
    (``{"query": ..., "user_id": ..., "vin": ..., "history": [...]}``) and
    wraps the response into a text-only AssistantMessage. Tools are ignored
    (pass an empty list); all tool execution happens inside the black-box.
    """

    def __init__(
        self,
        tools: list,
        domain_policy: str,
        *,
        base_url: str,
        endpoint: str = DEFAULT_BLACKBOX_HTTP_ENDPOINT,
        api_key: Optional[str] = None,
        user_id: Optional[str] = None,
        vin: Optional[str] = None,
        timeout: float = DEFAULT_BLACKBOX_HTTP_TIMEOUT,
        send_history: bool = False,
        extra_headers: Optional[dict[str, str]] = None,
        max_retries: int = DEFAULT_BLACKBOX_HTTP_MAX_RETRIES,
        retry_backoff_seconds: float = DEFAULT_BLACKBOX_HTTP_RETRY_BACKOFF_SECONDS,
    ):
        super().__init__(tools=tools, domain_policy=domain_policy)
        self.base_url = base_url.rstrip("/")
        self.endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
        self.api_key = api_key
        self.user_id = user_id
        self.vin = vin
        self.timeout = timeout
        self.send_history = send_history
        self.extra_headers = dict(extra_headers or {})
        self.max_retries = max(1, int(max_retries))
        self.retry_backoff_seconds = max(0.0, float(retry_backoff_seconds))
        if self.user_id is None or self.vin is None:
            logger.warning(
                "BlackboxHTTPAgent constructed without user_id/vin; "
                "these fields will be omitted from requests. "
                "Set them via --agent-llm-args or BLACKBOX_HTTP_USER_ID/BLACKBOX_HTTP_VIN."
            )

    # ------------------------------------------------------------------
    # HalfDuplexAgent interface
    # ------------------------------------------------------------------

    def get_init_state(
        self,
        message_history: Optional[list[Message]] = None,
    ) -> BlackboxHTTPAgentState:
        """Build the initial state, optionally seeded from a message history."""
        state = BlackboxHTTPAgentState()
        if message_history:
            for message in message_history:
                if not is_valid_agent_history_message(message):
                    continue
                role = "assistant" if isinstance(message, AssistantMessage) else "user"
                content = (message.content or "").strip()
                if content:
                    state.history.append({"role": role, "content": content})
        return state

    def generate_next_message(
        self, message, state: BlackboxHTTPAgentState
    ) -> tuple[AssistantMessage, BlackboxHTTPAgentState]:
        """Forward the user message to the blackbox service and wrap the reply."""
        query = self._extract_query_text(message)

        payload: dict[str, Any] = {"query": query}
        if self.user_id is not None:
            payload["user_id"] = self.user_id
        if self.vin is not None:
            payload["vin"] = self.vin
        if self.send_history and state.history:
            payload["history"] = [dict(turn) for turn in state.history]

        try:
            data = self._post_with_retries(payload)
        except BlackboxHTTPError as e:
            logger.error(f"BlackboxHTTPAgent request failed: {e}")
            state.history.append({"role": "user", "content": query})
            return (
                AssistantMessage.text(
                    content=f"{ERROR_MARKER} {e}", raw_data={"payload": payload}
                ),
                state,
            )

        reply_text, actions, usage = parse_blackbox_response(data)
        content = format_assistant_content(reply_text, actions)
        if not content.strip():
            content = f"{ERROR_MARKER} Blackbox agent returned an empty response."

        state.history.append({"role": "user", "content": query})
        state.history.append({"role": "assistant", "content": content})
        return (
            AssistantMessage.text(
                content=content, usage=usage, raw_data={"response": data}
            ),
            state,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _extract_query_text(self, message) -> str:
        """Extract the text to send as ``query`` from an input message."""
        if isinstance(message, UserMessage):
            if message.is_audio:
                raise ValueError(
                    "User message cannot be audio. BlackboxHTTPAgent is text-only."
                )
            return message.content or ""
        if isinstance(message, MultiToolMessage):
            # Should not happen (tools are empty), but stay defensive.
            return "\n".join(str(m) for m in message.tool_messages)
        if isinstance(message, ToolMessage):
            return str(message)
        return str(message)

    def _post_with_retries(self, payload: dict[str, Any]) -> Any:
        """POST the payload, retrying transient failures.

        Retries connection errors, timeouts and 5xx responses. 4xx responses
        and non-JSON bodies raise immediately (retrying will not help).

        Returns:
            The parsed JSON response (dict or other JSON value), or the raw
            response text if the body is not valid JSON.

        Raises:
            BlackboxHTTPError: If the request fails permanently.
        """
        url = f"{self.base_url}{self.endpoint}"
        headers = {"Content-Type": "application/json", **self.extra_headers}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        last_error = "unknown error"
        for attempt in range(1, self.max_retries + 1):
            try:
                response = requests.post(
                    url, json=payload, headers=headers, timeout=self.timeout
                )
            except requests.RequestException as e:
                last_error = f"{type(e).__name__}: {e}"
            else:
                if response.status_code >= 500:
                    last_error = f"HTTP {response.status_code}: {response.text[:500]}"
                elif response.status_code >= 400:
                    raise BlackboxHTTPError(
                        f"Blackbox agent returned HTTP {response.status_code}: "
                        f"{response.text[:500]}"
                    )
                else:
                    try:
                        return response.json()
                    except ValueError:
                        if response.text.strip():
                            return response.text
                        raise BlackboxHTTPError(
                            "Blackbox agent returned an empty body."
                        )
            if attempt < self.max_retries:
                logger.warning(
                    f"Blackbox agent request failed (attempt {attempt}/{self.max_retries}): "
                    f"{last_error}. Retrying in {self.retry_backoff_seconds}s..."
                )
                if self.retry_backoff_seconds:
                    time.sleep(self.retry_backoff_seconds)
        raise BlackboxHTTPError(
            f"Blackbox agent request failed after {self.max_retries} attempts: {last_error}"
        )


def _first(*candidates: Any, default: Any = None) -> Any:
    """Return the first non-None candidate, else the default."""
    for candidate in candidates:
        if candidate is not None:
            return candidate
    return default


def _env_flag(name: str) -> Optional[bool]:
    """Parse a boolean flag from an environment variable."""
    value = os.environ.get(name)
    if value is None:
        return None
    return value.strip().lower() in ("1", "true", "yes", "on")


def create_blackbox_http_agent(
    tools: list, domain_policy: str, **kwargs
) -> BlackboxHTTPAgent:
    """Factory for BlackboxHTTPAgent (registered as ``blackbox_http_agent``).

    Settings resolution order: ``llm_args`` (via ``--agent-llm-args`` JSON) >
    ``BLACKBOX_HTTP_*`` environment variables > ``tau2.config`` defaults.

    Supported ``llm_args`` keys:
        base_url, endpoint, api_key, user_id, vin, timeout, send_history,
        extra_headers, max_retries, retry_backoff_seconds
    """
    settings = kwargs.get("llm_args") or {}

    base_url = _first(
        settings.get("base_url"),
        os.environ.get("BLACKBOX_HTTP_BASE_URL"),
        default=DEFAULT_BLACKBOX_HTTP_BASE_URL,
    )
    endpoint = _first(
        settings.get("endpoint"),
        os.environ.get("BLACKBOX_HTTP_ENDPOINT"),
        default=DEFAULT_BLACKBOX_HTTP_ENDPOINT,
    )
    api_key = _first(settings.get("api_key"), os.environ.get("BLACKBOX_HTTP_API_KEY"))
    user_id = _first(settings.get("user_id"), os.environ.get("BLACKBOX_HTTP_USER_ID"))
    vin = _first(settings.get("vin"), os.environ.get("BLACKBOX_HTTP_VIN"))
    timeout = float(
        _first(
            settings.get("timeout"),
            os.environ.get("BLACKBOX_HTTP_TIMEOUT"),
            default=DEFAULT_BLACKBOX_HTTP_TIMEOUT,
        )
    )
    send_history = bool(
        _first(
            settings.get("send_history"),
            _env_flag("BLACKBOX_HTTP_SEND_HISTORY"),
            default=False,
        )
    )
    max_retries = int(
        _first(
            settings.get("max_retries"),
            default=DEFAULT_BLACKBOX_HTTP_MAX_RETRIES,
        )
    )
    retry_backoff_seconds = float(
        _first(
            settings.get("retry_backoff_seconds"),
            default=DEFAULT_BLACKBOX_HTTP_RETRY_BACKOFF_SECONDS,
        )
    )

    return BlackboxHTTPAgent(
        tools=tools,
        domain_policy=domain_policy,
        base_url=base_url,
        endpoint=endpoint,
        api_key=api_key,
        user_id=user_id,
        vin=vin,
        timeout=timeout,
        send_history=send_history,
        extra_headers=settings.get("extra_headers"),
        max_retries=max_retries,
        retry_backoff_seconds=retry_backoff_seconds,
    )
