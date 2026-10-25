"""Claude calls for the Library Builder, plus FakeAnthropic for --fake-llm.

One streamed messages call per batch: claude-opus-5-5, adaptive thinking (always on for this
model, so no thinking parameter), explicit effort, JSON structured output, cached system prompt,
server-side refusal fallbacks. No temperature/top_p/top_k and no assistant prefill (both 400).
"""
from __future__ import annotations

import copy
import json
import os
import re
import time
from types import SimpleNamespace

try:
    import anthropic
except ImportError:  # only --fake-llm works without it
    anthropic = None

FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 64000
NO_CREDENTIALS = ("Set ANTHROPIC_API_KEY (or run `ant auth login`): no usable Anthropic credentials were found. "
                  "Exiting with code 3.")


class LLMError(Exception):
    """kind: fatal | refusal | truncated | fallbacks | bad_request | rate_limit | retry | bad_output"""

    def __init__(self, kind, message, wait=None, info=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.wait = wait
        self.info = info or {}


def make_client(fake_fixture=None):
    if fake_fixture:
        return FakeAnthropic(fake_fixture)
    if anthropic is None:
        raise LLMError("fatal", "The anthropic package is not installed: run .venv/bin/pip install -r requirements.txt")
    try:
        # Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
        return anthropic.Anthropic(max_retries=5, timeout=900.0)
    except Exception as e:
        raise classify_error(e, "") from None


def classify_error(e, model):
    """Map an SDK exception to an LLMError, most specific first."""
    if isinstance(e, LLMError):
        return e
    if anthropic is not None:
        if isinstance(e, anthropic.AuthenticationError):
            return LLMError("fatal", f"Set ANTHROPIC_API_KEY (or run `ant auth login`): the API rejected the "
                                     f"credentials (401). {e.message}")
        if isinstance(e, anthropic.PermissionDeniedError):
            return LLMError("fatal", f"Set ANTHROPIC_API_KEY to a key that may use {model}: permission denied (403). "
                                     f"{e.message}")
        if isinstance(e, anthropic.NotFoundError):
            return LLMError("fatal", f"Model {model!r} was not found or is not available to this account (404); "
                                     f"check --model. {e.message}")
        if isinstance(e, anthropic.BadRequestError):
            text = (e.message or "").lower()
            if "fallback" in text or "anthropic-beta" in text:  # the fallbacks body field or its beta header
                return LLMError("fallbacks", e.message)
            return LLMError("bad_request", e.message)
        if isinstance(e, anthropic.RateLimitError):
            try:
                wait = max(1.0, float(e.response.headers.get("retry-after", "60")))
            except (TypeError, ValueError):
                wait = 60.0
            return LLMError("rate_limit", e.message, wait=wait)
        if isinstance(e, anthropic.APIStatusError):
            if e.status_code == 402:
                return LLMError("fatal", f"Anthropic billing problem (402): {e.message}")
            if e.status_code >= 500 or e.status_code in (408, 409, 425):  # still failing after the SDK's retries
                return LLMError("retry", f"API error {e.status_code}: {e.message}")
            return LLMError("bad_request", f"API error {e.status_code}: {e.message}")
        if isinstance(e, anthropic.APIConnectionError):  # includes APITimeoutError
            return LLMError("retry", f"{type(e).__name__}: {e}")
        cred_errors = tuple(c for c in (getattr(anthropic, "CredentialsError", None),
                                        getattr(anthropic, "WorkloadIdentityError", None)) if c)
        if cred_errors and isinstance(e, cred_errors):
            return LLMError("fatal", f"Set ANTHROPIC_API_KEY (or run `ant auth login`): {e}")
    if isinstance(e, TypeError) and "authentication" in str(e).lower():
        # The SDK raises a bare TypeError before sending when it finds no credentials at all.
        return LLMError("fatal", NO_CREDENTIALS)
    return LLMError("retry", f"{type(e).__name__}: {e}")


def usage_dict(msg):
    u = getattr(msg, "usage", None)
    return {k: getattr(u, k, None) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                                             "cache_creation_input_tokens")}


def fallback_used(msg, requested_model=None):
    if any(getattr(b, "type", None) == "fallback" for b in (getattr(msg, "content", None) or [])):
        return True
    for it in getattr(getattr(msg, "usage", None), "iterations", None) or []:
        t = it.get("type") if isinstance(it, dict) else getattr(it, "type", None)
        if t == "fallback_message":
            return True
    # Sticky routing serves later turns from the fallback model with no fallback block, and the
    # non-beta stream accumulator drops usage.iterations; the top-level model still names it.
    served = getattr(msg, "model", None)
    return bool(requested_model and served and not str(served).startswith(requested_model))


def extract_moves(msg):
    """The JSON list of moves from a structured-output response.

    Normally the first text block. After a mid-stream refusal fallback, the content can hold a
    partial text block, a `fallback` block, then the fallback model's text, so try the text after
    the last fallback block, then all text joined, then the first text block.
    """
    blocks = list(getattr(msg, "content", None) or [])
    texts = [(i, b.text) for i, b in enumerate(blocks)
             if getattr(b, "type", None) == "text" and isinstance(getattr(b, "text", None), str)]
    last_fb = max((i for i, b in enumerate(blocks) if getattr(b, "type", None) == "fallback"), default=-1)
    candidates = [t for i, t in texts if i > last_fb][:1]
    if len(texts) > 1:
        candidates.append("".join(t for _, t in texts))
    if texts:
        candidates.append(texts[0][1])
    for c in candidates:
        try:
            data = json.loads(c)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("moves"), list):
            return data["moves"]
        if isinstance(data, list):
            return data
    raise LLMError("bad_output", "no parseable {\"moves\": [...]} JSON in the response")


class SpecWriter:
    def __init__(self, client, model, effort, system_prompt, schema):
        self.client = client
        self.model = model
        self.effort = effort
        self.system_prompt = system_prompt
        self.schema = schema

    def check_access(self):
        """Preflight that costs no tokens: GET /v1/models/{model}. Raises LLMError ("fatal" for missing
        or bad credentials and an unknown model, so the agent exits 3 at once instead of first
        waiting on the game server)."""
        try:
            self.client.with_options(timeout=30.0, max_retries=2).models.retrieve(self.model)
        except Exception as e:
            raise classify_error(e, self.model) from None

    def write(self, user_text, use_fallbacks):
        """Return (raw_moves, info). Raises LLMError."""
        kwargs = dict(
            model=self.model,
            max_tokens=MAX_TOKENS,
            system=[{"type": "text", "text": self.system_prompt, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_text}],
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": self.schema}},
        )
        if use_fallbacks:
            kwargs["extra_headers"] = {"anthropic-beta": FALLBACK_BETA}
            kwargs["extra_body"] = {"fallbacks": "default"}
        t0 = time.time()
        try:
            with self.client.messages.stream(**kwargs) as stream:
                msg = stream.get_final_message()
                request_id = getattr(msg, "_request_id", None) or getattr(stream, "request_id", None)
        except Exception as e:
            raise classify_error(e, self.model) from None
        info = {
            "request_id": request_id,
            "model": getattr(msg, "model", None),
            "seconds": round(time.time() - t0, 1),
            "usage": usage_dict(msg),
            "stop_reason": getattr(msg, "stop_reason", None),
            "fallback": fallback_used(msg, self.model),
            "fallbacks_requested": bool(use_fallbacks),
        }
        # stop_reason before content: a refusal's content is empty or partial.
        if info["stop_reason"] == "refusal":
            d = getattr(msg, "stop_details", None)
            detail = (f"category={getattr(d, 'category', None)} explanation={getattr(d, 'explanation', None)}"
                      if d is not None else "no stop_details")
            raise LLMError("refusal", detail, info=info)
        if info["stop_reason"] in ("max_tokens", "model_context_window_exceeded"):
            raise LLMError("truncated", f"the output was cut off ({info['stop_reason']}, max_tokens={MAX_TOKENS})",
                           info=info)
        try:
            moves = extract_moves(msg)
        except LLMError as e:
            e.info = info
            raise
        return moves, info


# --------------------------------------------------------------------------- --fake-llm

class FakeAnthropic:
    """Stands in for anthropic.Anthropic under --fake-llm. No network, no key.

    Returns specs from fake_specs.json: batch k gets the fixture slice starting at k * count
    (the agent sets batch_no before each call), wrapping around with " II", " III" name
    suffixes. Checks the request shape the real API would reject.
    Env: FAKE_LLM_DELAY seconds per call (default 1); FAKE_LLM_SCRIPT a comma list of outcomes
    for the next calls: ok, refusal, max_tokens, bad_json, fallback_block, bad_request,
    bad_request_fallbacks, rate_limit, connection, server_error, auth.
    """

    def __init__(self, fixture_path):
        with open(fixture_path, encoding="utf-8") as f:
            data = json.load(f)
        self.specs = data["specs"] if isinstance(data, dict) else data
        self.batch_no = 0
        self.calls = 0
        self.delay = float(os.environ.get("FAKE_LLM_DELAY", "1.0"))
        self.script = [s.strip() for s in os.environ.get("FAKE_LLM_SCRIPT", "").split(",") if s.strip()]
        self.messages = SimpleNamespace(stream=self._stream)
        self.models = SimpleNamespace(retrieve=lambda model, **kw: SimpleNamespace(id=model, type="model"))

    def with_options(self, **kw):
        return self

    def _stream(self, **kwargs):
        return _FakeStream(self, kwargs)

    def _error(self, cls, status, message, headers=None):
        import httpx2  # installed with anthropic 2.x
        req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
        resp = httpx2.Response(status, request=req, headers=headers or {"request-id": f"fake_req_{self.calls}"})
        return cls(message, response=resp, body={"type": "error", "error": {"type": "fake", "message": message}})

    def _check_request(self, kw):
        bad = [k for k in ("thinking", "temperature", "top_p", "top_k") if k in kw]
        if bad:
            raise self._error(anthropic.BadRequestError, 400, f"fake API: {bad} not allowed on this model")
        oc = kw.get("output_config") or {}
        fmt = oc.get("format") or {}
        if oc.get("effort") not in ("low", "medium", "high", "xhigh", "max") or fmt.get("type") != "json_schema":
            raise self._error(anthropic.BadRequestError, 400, "fake API: output_config needs effort and a json_schema")
        if kw["messages"][-1]["role"] != "user":
            raise self._error(anthropic.BadRequestError, 400, "fake API: prefill is not supported")

    def _pick(self, count):
        out = []
        n = len(self.specs)
        start = self.batch_no * count
        for i in range(count):
            spec = copy.deepcopy(self.specs[(start + i) % n])
            lap = (start + i) // n
            if lap and isinstance(spec, dict) and isinstance(spec.get("name"), str):
                suffix = " " + "I" * (lap + 1) if lap < 3 else f" {lap + 1}"
                spec["name"] += suffix
                if isinstance(spec.get("aliases"), list):
                    spec["aliases"] = [a + suffix.lower() for a in spec["aliases"] if isinstance(a, str)]
            out.append(spec)
        return out

    def respond(self, kw):
        self.calls += 1
        outcome = self.script.pop(0) if self.script else "ok"
        time.sleep(self.delay)
        if anthropic is not None:
            self._check_request(kw)
            if outcome == "bad_request":
                raise self._error(anthropic.BadRequestError, 400, "fake API: something in the request is invalid")
            if outcome == "bad_request_fallbacks" and "extra_body" in kw:
                raise self._error(anthropic.BadRequestError, 400,
                                  f"Unexpected value(s) `{FALLBACK_BETA}` for the `anthropic-beta` header.")
            if outcome == "rate_limit":
                raise self._error(anthropic.RateLimitError, 429, "fake API: rate limited", {"retry-after": "3"})
            if outcome == "server_error":
                raise self._error(anthropic.InternalServerError, 500, "fake API: overloaded")
            if outcome == "auth":
                raise self._error(anthropic.AuthenticationError, 401, "fake API: invalid x-api-key")
            if outcome == "connection":
                import httpx2
                raise anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
        m = re.search(r"exactly (\d+) moves", kw["messages"][-1]["content"])
        count = int(m.group(1)) if m else 20
        text = json.dumps({"moves": self._pick(count)})
        usage = SimpleNamespace(input_tokens=3000, output_tokens=len(text) // 4,
                                cache_read_input_tokens=2500 if self.calls > 1 else 0,
                                cache_creation_input_tokens=0 if self.calls > 1 else 2500)
        msg = SimpleNamespace(model=kw["model"], stop_reason="end_turn", stop_details=None, usage=usage,
                              content=[SimpleNamespace(type="thinking", thinking=""),
                                       SimpleNamespace(type="text", text=text)],
                              _request_id=f"fake_req_{self.calls}")
        if outcome == "refusal":
            msg.stop_reason = "refusal"
            msg.content = []
            msg.stop_details = SimpleNamespace(type="refusal", category="cyber", explanation="fake refusal")
        elif outcome == "max_tokens":
            msg.stop_reason = "max_tokens"
            msg.content = [SimpleNamespace(type="text", text=text[: len(text) // 2])]
        elif outcome == "bad_json":
            msg.content = [SimpleNamespace(type="text", text=text[:-10])]
        elif outcome == "fallback_block":
            msg.content = [SimpleNamespace(type="text", text=text[:40]),
                           SimpleNamespace(type="fallback", text=None),
                           SimpleNamespace(type="text", text=text)]
        return msg


class _FakeStream:
    def __init__(self, owner, kwargs):
        self.owner = owner
        self.kwargs = kwargs
        self.request_id = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.owner.respond(self.kwargs)
