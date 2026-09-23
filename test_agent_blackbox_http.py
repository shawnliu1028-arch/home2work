"""Tests for the BlackboxHTTPAgent adapter (ticket 01).

Uses a local mock HTTP server (stdlib http.server) — no external services.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tau2.agent.blackbox_http_agent import (
    ERROR_MARKER,
    BlackboxHTTPAgent,
    create_blackbox_http_agent,
    format_assistant_content,
    parse_blackbox_response,
)
from tau2.data_model.message import AssistantMessage, UserMessage
from tau2.registry import registry

# ----------------------------------------------------------------------
# Mock server infrastructure
# ----------------------------------------------------------------------


class MockHandler(BaseHTTPRequestHandler):
    """Records requests; subclasses override ``respond``."""

    requests: list[dict] = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw)
        except ValueError:
            body = raw.decode("utf-8", errors="replace")
        type(self).requests.append(
            {"path": self.path, "headers": dict(self.headers), "body": body}
        )
        status, payload, content_type = self.respond(body)
        if isinstance(payload, (dict, list)):
            data = json.dumps(payload).encode("utf-8")
        else:
            data = str(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def respond(self, body):
        raise NotImplementedError

    def log_message(self, *args):
        pass


@pytest.fixture
def start_server():
    servers = []

    def _start(handler_cls):
        handler_cls.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}"

    yield _start
    for server in servers:
        server.shutdown()
        server.server_close()


def make_agent(base_url, **kwargs):
    defaults = dict(
        tools=[],
        domain_policy="test policy",
        base_url=base_url,
        api_key="secret-token",
        user_id="user-123",
        vin="VIN000TEST",
        max_retries=1,
        retry_backoff_seconds=0.0,
        timeout=5.0,
    )
    defaults.update(kwargs)
    return BlackboxHTTPAgent(**defaults)


def user_msg(text):
    return UserMessage(role="user", content=text)


# ----------------------------------------------------------------------
# Happy paths
# ----------------------------------------------------------------------


class OpenAIChatHandler(MockHandler):
    def respond(self, body):
        return (
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "好的，已为您打开车窗。",
                        }
                    }
                ],
                "usage": {"total_tokens": 42},
            },
            "application/json",
        )


def test_happy_path_openai_chat_completion(start_server):
    base_url = start_server(OpenAIChatHandler)
    agent = make_agent(base_url)
    state = agent.get_init_state()

    msg, state = agent.generate_next_message(user_msg("帮我打开车窗"), state)

    assert isinstance(msg, AssistantMessage)
    assert msg.role == "assistant"
    assert msg.content == "好的，已为您打开车窗。"
    assert msg.tool_calls is None
    assert msg.usage == {"total_tokens": 42}

    # Request shape: query + user_id + vin, no history by default.
    recorded = OpenAIChatHandler.requests[-1]
    assert recorded["path"] == "/chat"
    assert recorded["body"] == {
        "query": "帮我打开车窗",
        "user_id": "user-123",
        "vin": "VIN000TEST",
    }
    # Bearer auth is attached.
    assert recorded["headers"].get("Authorization") == "Bearer secret-token"

    # State history is updated.
    assert state.history == [
        {"role": "user", "content": "帮我打开车窗"},
        {"role": "assistant", "content": "好的，已为您打开车窗。"},
    ]


class BareMessageHandler(MockHandler):
    def respond(self, body):
        return (
            200,
            {"role": "assistant", "content": "bare message reply"},
            "application/json",
        )


def test_bare_message_format(start_server):
    base_url = start_server(BareMessageHandler)
    agent = make_agent(base_url)
    msg, _ = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert msg.content == "bare message reply"


class PlainTextHandler(MockHandler):
    def respond(self, body):
        return 200, "plain text reply", "text/plain"


def test_plain_text_body(start_server):
    base_url = start_server(PlainTextHandler)
    agent = make_agent(base_url)
    msg, _ = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert msg.content == "plain text reply"


# ----------------------------------------------------------------------
# Structured action results must be embedded in the message text
# ----------------------------------------------------------------------


class ActionsTopLevelHandler(MockHandler):
    def respond(self, body):
        return (
            200,
            {
                "choices": [{"message": {"role": "assistant", "content": "已执行。"}}],
                "actions": [
                    {"action": "open_window", "status": "success"},
                    {"action": "set_ac", "status": "success", "temperature": 22},
                ],
            },
            "application/json",
        )


def test_actions_transparently_embedded_top_level(start_server):
    base_url = start_server(ActionsTopLevelHandler)
    agent = make_agent(base_url)
    msg, _ = agent.generate_next_message(
        user_msg("开窗并调空调"), agent.get_init_state()
    )
    assert msg.content.startswith("已执行。")
    assert "[Action results]" in msg.content
    assert '"action": "open_window"' in msg.content
    assert '"status": "success"' in msg.content
    assert '"temperature": 22' in msg.content


class ActionsWithToolCallsHandler(MockHandler):
    def respond(self, body):
        return (
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "open_window",
                                        "arguments": {"position": "front"},
                                    },
                                }
                            ],
                        }
                    }
                ]
            },
            "application/json",
        )


def test_tool_calls_only_response(start_server):
    base_url = start_server(ActionsWithToolCallsHandler)
    agent = make_agent(base_url)
    msg, _ = agent.generate_next_message(user_msg("开窗"), agent.get_init_state())
    assert "[Action results]" in msg.content
    assert '"name": "open_window"' in msg.content
    # No tool_calls on the tau2 AssistantMessage itself.
    assert msg.tool_calls is None


# ----------------------------------------------------------------------
# History mode
# ----------------------------------------------------------------------


class EchoHistoryHandler(MockHandler):
    def respond(self, body):
        n = len(body.get("history", [])) if isinstance(body, dict) else 0
        return (
            200,
            {"choices": [{"message": {"content": f"turn {n}"}}]},
            "application/json",
        )


def test_history_sent_when_enabled(start_server):
    base_url = start_server(EchoHistoryHandler)
    agent = make_agent(base_url, send_history=True)
    state = agent.get_init_state()

    _, state = agent.generate_next_message(user_msg("第一句"), state)
    _, state = agent.generate_next_message(user_msg("第二句"), state)

    second_request = EchoHistoryHandler.requests[-1]["body"]
    assert second_request["history"] == [
        {"role": "user", "content": "第一句"},
        {"role": "assistant", "content": "turn 0"},
    ]


def test_history_not_sent_by_default(start_server):
    base_url = start_server(EchoHistoryHandler)
    agent = make_agent(base_url)
    state = agent.get_init_state()
    _, state = agent.generate_next_message(user_msg("第一句"), state)
    _, state = agent.generate_next_message(user_msg("第二句"), state)

    assert "history" not in EchoHistoryHandler.requests[-1]["body"]


def test_get_init_state_from_message_history():
    agent = make_agent("http://localhost:9")
    state = agent.get_init_state(
        message_history=[
            UserMessage(role="user", content="历史用户消息"),
            AssistantMessage(role="assistant", content="历史助手消息"),
        ]
    )
    assert state.history == [
        {"role": "user", "content": "历史用户消息"},
        {"role": "assistant", "content": "历史助手消息"},
    ]


# ----------------------------------------------------------------------
# Error handling: must not crash the orchestrator
# ----------------------------------------------------------------------


class ServerErrorHandler(MockHandler):
    def respond(self, body):
        return 500, {"error": "internal error"}, "application/json"


def test_http_500_becomes_observable_error_message(start_server):
    base_url = start_server(ServerErrorHandler)
    agent = make_agent(base_url, max_retries=2, retry_backoff_seconds=0.0)
    msg, state = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert isinstance(msg, AssistantMessage)
    assert msg.content.startswith(ERROR_MARKER)
    assert "HTTP 500" in msg.content
    # Retried once.
    assert len(ServerErrorHandler.requests) == 2
    # User turn is still recorded in state.
    assert state.history == [{"role": "user", "content": "hi"}]


class BadRequestHandler(MockHandler):
    def respond(self, body):
        return 400, {"error": "bad request"}, "application/json"


def test_http_400_no_retry(start_server):
    base_url = start_server(BadRequestHandler)
    agent = make_agent(base_url, max_retries=3, retry_backoff_seconds=0.0)
    msg, _ = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert msg.content.startswith(ERROR_MARKER)
    assert "HTTP 400" in msg.content
    assert len(BadRequestHandler.requests) == 1


def test_connection_error_becomes_observable_error_message():
    # Port 1 on localhost is not listening -> ConnectionError.
    agent = make_agent("http://127.0.0.1:1", max_retries=1)
    msg, _ = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert msg.content.startswith(ERROR_MARKER)


class EmptyBodyHandler(MockHandler):
    def respond(self, body):
        return 200, "", "application/json"


def test_empty_body_becomes_observable_error_message(start_server):
    base_url = start_server(EmptyBodyHandler)
    agent = make_agent(base_url)
    msg, _ = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert msg.content.startswith(ERROR_MARKER)
    assert "empty" in msg.content.lower()


class EmptyContentHandler(MockHandler):
    def respond(self, body):
        return (
            200,
            {"choices": [{"message": {"role": "assistant", "content": ""}}]},
            "application/json",
        )


def test_empty_content_becomes_observable_error_message(start_server):
    base_url = start_server(EmptyContentHandler)
    agent = make_agent(base_url)
    msg, _ = agent.generate_next_message(user_msg("hi"), agent.get_init_state())
    assert msg.content.startswith(ERROR_MARKER)


def test_audio_user_message_rejected():
    agent = make_agent("http://localhost:9")
    state = agent.get_init_state()
    with pytest.raises(ValueError, match="cannot be audio"):
        agent.generate_next_message(
            UserMessage(role="user", content="x", is_audio=True), state
        )


# ----------------------------------------------------------------------
# Response parsing unit tests
# ----------------------------------------------------------------------


def test_parse_non_dict_string():
    assert parse_blackbox_response("hello") == ("hello", [], None)


def test_parse_non_dict_list():
    text, actions, usage = parse_blackbox_response([1, 2])
    assert text == "[1, 2]"
    assert actions == []


def test_parse_openai_full():
    text, actions, usage = parse_blackbox_response(
        {"choices": [{"message": {"content": "hi"}}], "usage": {"total_tokens": 5}}
    )
    assert text == "hi"
    assert actions == []
    assert usage == {"total_tokens": 5}


def test_parse_bare_message():
    text, actions, usage = parse_blackbox_response(
        {"role": "assistant", "content": "hi"}
    )
    assert (text, actions, usage) == ("hi", [], None)


def test_parse_reply_actions():
    text, actions, _ = parse_blackbox_response(
        {"reply": "done", "actions": [{"action": "a", "status": "ok"}]}
    )
    assert text == "done"
    assert actions == [{"action": "a", "status": "ok"}]


def test_parse_nothing_recognized_falls_back_to_raw_json():
    text, actions, _ = parse_blackbox_response({"foo": "bar"})
    assert json.loads(text) == {"foo": "bar"}
    assert actions == []


def test_format_assistant_content():
    assert format_assistant_content("hi", []) == "hi"
    assert format_assistant_content("", []) == ""
    content = format_assistant_content("hi", [{"action": "a"}])
    assert content == 'hi\n[Action results]\n{"action": "a"}'


# ----------------------------------------------------------------------
# Factory and registry
# ----------------------------------------------------------------------


def test_factory_registered_in_registry():
    assert "blackbox_http_agent" in registry.get_agents()
    factory = registry.get_agent_factory("blackbox_http_agent")
    assert factory is create_blackbox_http_agent


def test_factory_from_llm_args():
    agent = create_blackbox_http_agent(
        tools=[],
        domain_policy="policy",
        llm_args={
            "base_url": "http://example.com/",
            "endpoint": "v1/chat",
            "api_key": "k",
            "user_id": "u",
            "vin": "v",
            "send_history": True,
        },
    )
    assert isinstance(agent, BlackboxHTTPAgent)
    assert agent.base_url == "http://example.com"
    assert agent.endpoint == "/v1/chat"
    assert agent.api_key == "k"
    assert agent.user_id == "u"
    assert agent.vin == "v"
    assert agent.send_history is True


def test_factory_from_env(monkeypatch):
    monkeypatch.setenv("BLACKBOX_HTTP_BASE_URL", "http://env.example.com")
    monkeypatch.setenv("BLACKBOX_HTTP_API_KEY", "env-key")
    monkeypatch.setenv("BLACKBOX_HTTP_USER_ID", "env-user")
    monkeypatch.setenv("BLACKBOX_HTTP_VIN", "env-vin")
    monkeypatch.setenv("BLACKBOX_HTTP_SEND_HISTORY", "true")
    agent = create_blackbox_http_agent([], "policy", llm_args={"temperature": 0.0})
    assert agent.base_url == "http://env.example.com"
    assert agent.api_key == "env-key"
    assert agent.user_id == "env-user"
    assert agent.vin == "env-vin"
    assert agent.send_history is True
