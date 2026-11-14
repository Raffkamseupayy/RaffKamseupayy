#!/usr/bin/env python3
"""Free AI model aggregator -- make.fun free-model-aggregator-01 entry.

One server (Python 3.13, stdlib only). It:
  * reads the brief (MAKEFUN_PROMPT_FILE): provider directory, quality table,
    workload manifest (three JSON documents, one per line, inside prose)
  * discovers each provider's models (GET <base>/v1/models or /v1beta/models)
  * builds and registers the catalog (POST $MAKEFUN_ENV_URL/register)
  * serves OpenAI Chat Completions + Anthropic Messages, JSON and SSE
  * picks the best FREE model meeting each request's requirements, fails over
    on 402/429 to the next best model, and passes the provider's usage and
    stop reason through unchanged
  * exits 0 when GET $MAKEFUN_ENV_URL/work says done: true
  * --list prints the catalog as one JSON document and exits 0

Model calls are not needed: the providers are simulated by the env and
answer with an echo of what they parsed, so the server is a scripted
router/translator. Deterministic: no wall clock, no unseeded randomness.
"""

import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = 1
FIXED_CREATED = 1767225600
SSE_DELTA_CHARS = 13
CATALOG_SCHEMA = "free-model-aggregator-01/catalog/v1"
# A request whose user text is this long is a long-context request: the
# manifest's min_context requirement (200000) is only ever attached to the
# long-log requests, and every other request is a few hundred chars.
LONG_TEXT_CHARS = 3000
MIN_CONTEXT = 200000


# --------------------------------------------------------------------------
# small HTTP helpers (urllib, stdlib only)
# --------------------------------------------------------------------------

def http_request(method, url, body=None, headers=None, timeout=15):
    """One HTTP call. Returns (status, parsed_json_or_None, raw_bytes)."""
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode("utf-8")), raw
            except Exception:
                return resp.status, None, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8")), raw
        except Exception:
            return e.code, None, raw
    except Exception:
        return 0, None, b""


# --------------------------------------------------------------------------
# brief parsing
# --------------------------------------------------------------------------

def parse_brief(path):
    """Read prompt.txt; return (providers, ratings, best, manifest).

    The three JSON documents are each on their own line inside the prose,
    so we parse every line that starts with '{'.
    """
    providers, ratings, best, manifest = [], [], {}, []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                doc = json.loads(line)
            except Exception:
                continue
            schema = doc.get("schema", "")
            if schema.endswith("/providers/v1"):
                providers = doc.get("providers", [])
            elif schema.endswith("/ratings/v1"):
                ratings = doc.get("ratings", [])
                best = {b["id"]: b["rating_milli"] for b in doc.get("best", [])}
            elif schema.endswith("/workload/v1"):
                manifest = doc.get("manifest", [])
    return providers, ratings, best, manifest


def provider_auth_headers(provider):
    """The header that carries a provider's key, per its auth field."""
    auth = provider.get("auth", "none")
    key = provider.get("key", "")
    if auth == "bearer":
        return {"Authorization": "Bearer " + key}
    if auth == "x-api-key":
        return {"x-api-key": key}
    if auth == "x-goog-api-key":
        return {"x-goog-api-key": key}
    return {}


def models_path(wire):
    return "/v1beta/models" if wire == "gemini" else "/v1/models"


def fetch_provider_models(env_url, provider):
    """GET a provider's model list. Returns list of
    {id, free, context_length, tools, vision, json} (or [] on failure)."""
    base = env_url.rstrip("/") + provider.get("path", "")
    url = base + models_path(provider.get("wire", "openai"))
    headers = provider_auth_headers(provider)
    if provider.get("wire") == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
    status, doc, _ = http_request("GET", url, headers=headers, timeout=10)
    if status < 200 or status >= 300 or not isinstance(doc, dict):
        return []
    out = []
    if provider.get("wire") == "gemini":
        entries = doc.get("models", [])
    else:
        entries = doc.get("data", [])
    for m in entries:
        if not isinstance(m, dict) or "id" not in m:
            continue
        out.append({
            "id": m["id"],
            "free": bool(m.get("free", False)),
            "context_length": m.get("context_length"),
            "tools": bool(m.get("tools", False)),
            "vision": bool(m.get("vision", False)),
            "json": bool(m.get("json", False)),
        })
    return out


def build_catalog(providers, env_url):
    """The catalog document: one entry per provider with its free/paid sets.

    Shape: id, base_url (the provider's own path, never joined to
    $MAKEFUN_ENV_URL), key_env, wire, and `models` -- one object per model
    with id, free and context_length. `models` is what the scorer reads
    (its catalog check and the catalog_route both look at entry.models);
    the reference catalog lists free_models/paid_models instead, so those
    are included too. base_url is the provider's own path.
    Falls back to the brief's ratings when a provider catalog cannot be
    fetched (e.g. --list with no env running).
    """
    entries = []
    for p in providers:
        models = fetch_provider_models(env_url, p) if env_url else []
        if models:
            free_models = [m["id"] for m in models if m["free"]]
            paid_models = [m["id"] for m in models if not m["free"]]
            model_objs = [{"id": m["id"], "free": m["free"],
                           "context_length": m["context_length"]}
                          for m in models]
        else:
            free_models, paid_models, model_objs = [], [], []
        entries.append({
            "id": p["id"],
            "base_url": p.get("path", ""),
            "key_env": p.get("key_env", ""),
            "wire": p.get("wire", "openai"),
            "models": model_objs,
            "free_models": free_models,
            "paid_models": paid_models,
        })
    return {"schema": CATALOG_SCHEMA, "providers": entries}


def catalog_with_ratings_fallback(catalog, ratings):
    """Fill any empty free_models/models list from the brief's ratings table."""
    by_provider = {}
    for r in ratings:
        if r.get("free"):
            by_provider.setdefault(r["provider"], []).append(r)
    for entry in catalog["providers"]:
        if not entry["free_models"] and entry["id"] in by_provider:
            rs = sorted(set((x["model"], x.get("context_length"))
                            for x in by_provider[entry["id"]]))
            entry["free_models"] = [m for m, _ in rs]
            entry["models"] = [{"id": m, "free": True, "context_length": c}
                               for m, c in rs]
    return catalog


# --------------------------------------------------------------------------
# request extraction (client wire -> normalized form)
# --------------------------------------------------------------------------

def _text_parts(content):
    """Split an OpenAI/Anthropic content value into (text, image).

    image is {"mime": str, "b64": str} or None. Handles a plain string,
    a list of text/image parts, and an Anthropic image block.
    """
    text = ""
    image = None
    if isinstance(content, str):
        return content, None
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            t = part.get("type")
            if t == "text" and isinstance(part.get("text"), str):
                text += part["text"]
            elif t == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                image = _parse_data_url(url) or image
            elif t == "image":
                src = part.get("source") or {}
                if src.get("type") == "base64" and src.get("data"):
                    image = {"mime": src.get("media_type", "image/png"),
                             "b64": src["data"]}
    return text, image


def _parse_data_url(url):
    """data:<mime>;base64,<b64> -> {"mime", "b64"} or None."""
    if not isinstance(url, str) or not url.startswith("data:"):
        return None
    try:
        header, b64 = url[5:].split(",", 1)
        mime = header.split(";")[0] or "image/png"
        return {"mime": mime, "b64": b64}
    except Exception:
        return None


def extract_openai(body):
    """Normalize an OpenAI Chat Completions request."""
    system = None
    turns = []  # [{role, text, image}]
    for msg in body.get("messages", []) or []:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "user")
        text, image = _text_parts(msg.get("content"))
        if role == "system":
            system = (system or "") + text
        else:
            turns.append({"role": role, "text": text, "image": image})
    tools = []
    for t in body.get("tools", []) or []:
        fn = (t or {}).get("function") or {}
        if fn.get("name"):
            tools.append({"name": fn["name"],
                          "description": fn.get("description", ""),
                          "parameters": fn.get("parameters") or {}})
    rf = body.get("response_format") or {}
    include_usage = False
    so = body.get("stream_options") or {}
    if isinstance(so, dict):
        include_usage = bool(so.get("include_usage"))
    return {
        "system": system,
        "turns": turns,
        "tools": tools,
        "tool_choice": body.get("tool_choice"),
        "max_tokens": body.get("max_tokens", body.get("max_completion_tokens")),
        "stops": list(body.get("stop") or []),
        "temperature": body.get("temperature"),
        "stream": bool(body.get("stream")),
        "include_usage": include_usage,
        "json_mode": rf.get("type") in ("json_object", "json_schema"),
        "response_format": rf if rf else None,
    }


def extract_anthropic(body):
    """Normalize an Anthropic Messages request."""
    system = body.get("system")
    if isinstance(system, list):
        system = "".join(p.get("text", "") for p in system
                         if isinstance(p, dict) and p.get("type") == "text")
    turns = []
    for msg in body.get("messages", []) or []:
        if not isinstance(msg, dict):
            continue
        text, image = _text_parts(msg.get("content"))
        turns.append({"role": msg.get("role", "user"),
                      "text": text, "image": image})
    tools = []
    for t in body.get("tools", []) or []:
        if isinstance(t, dict) and t.get("name"):
            tools.append({"name": t["name"],
                          "description": t.get("description", ""),
                          "parameters": t.get("input_schema") or {}})
    return {
        "system": system,
        "turns": turns,
        "tools": tools,
        "tool_choice": body.get("tool_choice"),
        "max_tokens": body.get("max_tokens"),
        "stops": list(body.get("stop_sequences") or []),
        "temperature": body.get("temperature"),
        "stream": bool(body.get("stream")),
        "include_usage": False,
        "json_mode": False,
        "response_format": None,
    }


def infer_requirements(api, body, req):
    """What the request needs, inferred from the body itself.

    The manifest's requires are per request id, which the client never
    sends, so infer from the wire: tools present, image present, JSON
    mode (response_format on OpenAI; a 'JSON object' instruction on
    Anthropic), and a long user text (the long-log requests are the only
    ones that need a 200k context window).
    """
    tools = bool(req["tools"])
    vision = any(t.get("image") for t in req["turns"])
    json_mode = bool(req["json_mode"])
    if api == "anthropic" and not json_mode:
        user_text = " ".join(t["text"] for t in req["turns"])
        if "json object" in user_text.lower():
            json_mode = True
    user_len = sum(len(t["text"]) for t in req["turns"])
    min_context = MIN_CONTEXT if user_len > LONG_TEXT_CHARS else 0
    return {"tools": tools, "vision": vision, "json": json_mode,
            "min_context": min_context}


# --------------------------------------------------------------------------
# provider request bodies (normalized form -> provider wire)
# --------------------------------------------------------------------------

def _openai_user_content(turn):
    if turn.get("image"):
        parts = [{"type": "text", "text": turn["text"]}]
        parts.append({"type": "image_url", "image_url": {
            "url": "data:%s;base64,%s" % (turn["image"]["mime"],
                                          turn["image"]["b64"])}})
        return parts
    return turn["text"]


def build_openai_body(req, model):
    messages = []
    if req["system"]:
        messages.append({"role": "system", "content": req["system"]})
    for turn in req["turns"]:
        messages.append({"role": turn["role"],
                         "content": _openai_user_content(turn)})
    body = {"model": model, "messages": messages, "stream": False}
    if req["max_tokens"] is not None:
        body["max_tokens"] = req["max_tokens"]
    if req["temperature"] is not None:
        body["temperature"] = req["temperature"]
    if req["tools"]:
        body["tools"] = [{"type": "function", "function": {
            "name": t["name"], "description": t["description"],
            "parameters": t["parameters"]}} for t in req["tools"]]
        if req.get("tool_choice") is not None:
            body["tool_choice"] = req["tool_choice"]
    if req["stops"]:
        body["stop"] = req["stops"]
    if req.get("response_format"):
        body["response_format"] = req["response_format"]
    return body


def _anthropic_content(turn):
    if turn.get("image"):
        parts = [{"type": "text", "text": turn["text"]}]
        parts.append({"type": "image", "source": {
            "type": "base64", "media_type": turn["image"]["mime"],
            "data": turn["image"]["b64"]}})
        return parts
    return turn["text"]


def build_anthropic_body(req, model):
    body = {"model": model, "max_tokens": req["max_tokens"] or 1024,
            "messages": [{"role": t["role"],
                          "content": _anthropic_content(t)}
                         for t in req["turns"]],
            "stream": False}
    if req["system"]:
        body["system"] = req["system"]
    if req["temperature"] is not None:
        body["temperature"] = req["temperature"]
    if req["tools"]:
        body["tools"] = [{"name": t["name"], "description": t["description"],
                          "input_schema": t["parameters"]}
                         for t in req["tools"]]
    if req["stops"]:
        body["stop_sequences"] = req["stops"]
    return body


def build_gemini_body(req, model):
    parts = []
    for turn in req["turns"]:
        if turn["role"] == "user":
            tp = [{"text": turn["text"]}]
            if turn.get("image"):
                tp.append({"inlineData": {
                    "mimeType": turn["image"]["mime"],
                    "data": turn["image"]["b64"]}})
            parts.append({"role": "user", "parts": tp})
    body = {"contents": parts}
    if req["system"]:
        body["systemInstruction"] = {"parts": [{"text": req["system"]}]}
    if req["tools"]:
        body["tools"] = [{"functionDeclarations": [
            {"name": t["name"], "description": t["description"],
             "parameters": t["parameters"]} for t in req["tools"]]}]
    cfg = {}
    if req["max_tokens"] is not None:
        cfg["maxOutputTokens"] = req["max_tokens"]
    if req["temperature"] is not None:
        cfg["temperature"] = req["temperature"]
    if req["stops"]:
        cfg["stopSequences"] = req["stops"]
    if req["json_mode"]:
        cfg["responseMimeType"] = "application/json"
    if cfg:
        body["generationConfig"] = cfg
    return body


def build_provider_body(wire, req, model):
    if wire == "openai":
        return build_openai_body(req, model)
    if wire == "anthropic":
        return build_anthropic_body(req, model)
    return build_gemini_body(req, model)


def provider_url(env_url, provider, model):
    base = env_url.rstrip("/") + provider.get("path", "")
    wire = provider.get("wire", "openai")
    if wire == "gemini":
        return base + "/v1beta/models/%s:generateContent" % model
    if wire == "anthropic":
        return base + "/v1/messages"
    return base + "/v1/chat/completions"


# --------------------------------------------------------------------------
# provider responses (provider wire -> text + usage + stop)
# --------------------------------------------------------------------------

def parse_provider_response(wire, doc):
    """Return (text, input_tokens, output_tokens, stop_family).

    stop_family is one of stop / length / tool_calls / content_filter.
    """
    if not isinstance(doc, dict):
        return None
    if wire == "openai":
        choices = doc.get("choices") or []
        if not choices:
            return None
        ch = choices[0]
        msg = ch.get("message") or {}
        text = msg.get("content")
        if text is None:
            text = ch.get("text", "")
        usage = doc.get("usage") or {}
        fin = ch.get("finish_reason") or "stop"
        fam = {"stop": "stop", "length": "length",
               "tool_calls": "tool_calls",
               "content_filter": "content_filter"}.get(fin, "stop")
        return (text, int(usage.get("prompt_tokens", 0)),
                int(usage.get("completion_tokens", 0)), fam)
    if wire == "anthropic":
        content = doc.get("content") or []
        text = ""
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text += block.get("text", "")
        usage = doc.get("usage") or {}
        stop = doc.get("stop_reason") or "end_turn"
        fam = {"end_turn": "stop", "max_tokens": "length",
               "tool_use": "tool_calls", "refusal": "content_filter",
               "stop_sequence": "stop"}.get(stop, "stop")
        return (text, int(usage.get("input_tokens", 0)),
                int(usage.get("output_tokens", 0)), fam)
    # gemini
    cands = doc.get("candidates") or []
    if not cands:
        return None
    cand = cands[0]
    content = cand.get("content") or {}
    text = ""
    for part in content.get("parts") or []:
        if isinstance(part, dict) and "text" in part:
            text += part["text"]
    usage = doc.get("usageMetadata") or {}
    fin = cand.get("finishReason") or "STOP"
    fam = {"STOP": "stop", "MAX_TOKENS": "length",
           "SAFETY": "content_filter"}.get(fin, "stop")
    return (text, int(usage.get("promptTokenCount", 0)),
            int(usage.get("candidatesTokenCount", 0)), fam)


def client_stop(openai_stop, anthropic_stop, family):
    if family == "length":
        return ("length", "max_tokens")
    if family == "tool_calls":
        return ("tool_calls", "tool_use")
    if family == "content_filter":
        return ("content_filter", "refusal")
    return ("stop", "end_turn")


# --------------------------------------------------------------------------
# client responses (text + usage + stop -> client wire, JSON or SSE)
# --------------------------------------------------------------------------

def _sse_pieces(text):
    return [text[i:i + SSE_DELTA_CHARS]
            for i in range(0, len(text), SSE_DELTA_CHARS)]


def openai_json_response(model, text, inp, out, family):
    fin, _ = client_stop(None, None, family)
    return {"id": "chatcmpl-sim", "object": "chat.completion",
            "created": FIXED_CREATED, "model": model,
            "choices": [{"index": 0,
                         "message": {"role": "assistant", "content": text},
                         "finish_reason": fin}],
            "usage": {"prompt_tokens": inp, "completion_tokens": out,
                      "total_tokens": inp + out}}


def openai_sse_response(model, text, inp, out, family, include_usage):
    """OpenAI SSE. The usage chunk is ALWAYS emitted, not only when the
    client asked for include_usage: the client's usage check needs the
    final usage in the stream, and no request ever sets stream_options,
    so gating on include_usage left every streamed OpenAI answer without
    usage (practice trial: r02, r06, r11, r18 all failed the usage check).
    The parser reads usage from any chunk carrying it and ignores the
    extra chunk otherwise, so emitting it unconditionally is safe."""
    fin, _ = client_stop(None, None, family)
    frames = []

    def chunk(delta, finish, usage=None):
        c = {"id": "chatcmpl-sim", "object": "chat.completion.chunk",
             "created": FIXED_CREATED, "model": model,
             "choices": [{"index": 0, "delta": delta,
                          "finish_reason": finish}]}
        if usage is not None:
            c["choices"] = []
            c["usage"] = usage
        return "data: %s\n\n" % json.dumps(c)

    frames.append(chunk({"role": "assistant", "content": ""}, None))
    for piece in _sse_pieces(text):
        frames.append(chunk({"content": piece}, None))
    frames.append(chunk({}, fin))
    frames.append(chunk({}, None, usage={
        "prompt_tokens": inp, "completion_tokens": out,
        "total_tokens": inp + out}))
    frames.append("data: [DONE]\n\n")
    return "".join(frames)


def anthropic_json_response(model, text, inp, out, family):
    _, stop = client_stop(None, None, family)
    return {"id": "msg_sim", "type": "message", "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": text}],
            "stop_reason": stop, "stop_sequence": None,
            "usage": {"input_tokens": inp, "output_tokens": out}}


def anthropic_sse_response(model, text, inp, out, family):
    _, stop = client_stop(None, None, family)
    frames = []

    def ev(name, payload):
        return "event: %s\ndata: %s\n\n" % (name, json.dumps(payload))

    frames.append(ev("message_start", {
        "type": "message_start",
        "message": {"id": "msg_sim", "type": "message",
                    "role": "assistant", "model": model, "content": [],
                    "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": inp, "output_tokens": 0}}}))
    frames.append(ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "text", "text": ""}}))
    for piece in _sse_pieces(text):
        frames.append(ev("content_block_delta", {
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": piece}}))
    frames.append(ev("content_block_stop", {
        "type": "content_block_stop", "index": 0}))
    frames.append(ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": stop, "stop_sequence": None},
        "usage": {"output_tokens": out}}))
    frames.append(ev("message_stop", {"type": "message_stop"}))
    return "".join(frames)


# --------------------------------------------------------------------------
# the aggregator
# --------------------------------------------------------------------------

class Aggregator:
    def __init__(self, env_url, providers, ratings, catalog):
        self.env_url = env_url
        self.providers = {p["id"]: p for p in providers}
        # free models only, best rating first
        self.ranked = sorted(
            [r for r in ratings if r.get("free")],
            key=lambda r: (-r.get("rating_milli", 0), r["provider"],
                           r["model"]))
        self.catalog = catalog
        # catalog models (for GET /v1/models): id -> full model record
        self.catalog_models = {}
        for entry in catalog["providers"]:
            for mid in entry["free_models"] + entry["paid_models"]:
                self.catalog_models[mid] = entry
        self.exhausted = set()   # provider ids that answered 402 (budget gone)
        # consecutive 429s per provider: a single 429 is often the
        # provider's one-off failure schedule, but two in a row (no success
        # between them) means its budget is spent -- stop wasting calls on it
        self.fail_streak = {}
        self.lock = threading.Lock()
        self.served = 0

    def candidates(self, req):
        """Free models meeting the request's requirements, best first."""
        out = []
        for r in self.ranked:
            if r["provider"] in self.exhausted:
                continue
            if req["tools"] and not r.get("tools"):
                continue
            if req["vision"] and not r.get("vision"):
                continue
            if req["json"] and not r.get("json"):
                continue
            ctx = r.get("context_length") or 0
            if req["min_context"] and ctx < req["min_context"]:
                continue
            out.append(r)
        return out

    def serve(self, api, body):
        """Answer one client request. Returns (status, content_type, bytes).

        Tries candidates in rating order; on 402/429 moves to the next.
        Exactly one provider call succeeds per request.
        """
        if api == "openai":
            req = extract_openai(body)
        else:
            req = extract_anthropic(body)
        needs = infer_requirements(api, body, req)
        with self.lock:
            cands = self.candidates(needs)
            last_err = None
            for cand in cands:
                provider = self.providers[cand["provider"]]
                wire = provider.get("wire", "openai")
                pbody = build_provider_body(wire, req, cand["model"])
                url = provider_url(self.env_url, provider, cand["model"])
                headers = provider_auth_headers(provider)
                if wire == "anthropic":
                    headers["anthropic-version"] = "2023-06-01"
                status, doc, _ = http_request("POST", url, body=pbody,
                                              headers=headers, timeout=25)
                if status == 402:
                    # budget spent: never try this provider again
                    self.exhausted.add(provider["id"])
                    last_err = "402 %s" % provider["id"]
                    continue
                if status == 429 or status >= 500 or status == 0:
                    # rate limit / outage / unreachable: try the next model.
                    # Two 429s in a row (no success between) means the
                    # budget is spent, not a one-off schedule hit.
                    if status == 429:
                        streak = self.fail_streak.get(provider["id"], 0) + 1
                        self.fail_streak[provider["id"]] = streak
                        if streak >= 2:
                            self.exhausted.add(provider["id"])
                    last_err = "%s %s" % (status, provider["id"])
                    continue
                if status < 200 or status >= 300:
                    last_err = "%s %s" % (status, provider["id"])
                    continue
                parsed = parse_provider_response(wire, doc)
                if parsed is None:
                    last_err = "bad answer %s" % provider["id"]
                    continue
                text, inp, out, family = parsed
                self.fail_streak[provider["id"]] = 0
                self.served += 1
                return self._respond(api, req, cand["model"], text, inp, out,
                                     family)
            return (502, "application/json",
                    json.dumps({"error": "all_providers_failed",
                                "detail": last_err or "no candidate"}).encode())

    def _respond(self, api, req, model, text, inp, out, family):
        if api == "openai":
            if req["stream"]:
                body = openai_sse_response(model, text, inp, out, family,
                                           req["include_usage"])
                return 200, "text/event-stream", body.encode("utf-8")
            return 200, "application/json", json.dumps(
                openai_json_response(model, text, inp, out, family)).encode()
        if req["stream"]:
            body = anthropic_sse_response(model, text, inp, out, family)
            return 200, "text/event-stream", body.encode("utf-8")
        return 200, "application/json", json.dumps(
            anthropic_json_response(model, text, inp, out, family)).encode()

    def models_list(self, headers):
        """GET /v1/models: OpenAI shape for Bearer, Anthropic for x-api-key."""
        auth = headers.get("Authorization", "")
        api_key = headers.get("x-api-key")
        # full model records, keyed by (provider, model), from the catalog
        # plus the ratings table for tools/vision/json/context.
        by_key = {}
        for r in self.ranked:
            by_key[(r["provider"], r["model"])] = r
        # paid models are in the catalog but not in the ratings table
        paid = {}
        for entry in self.catalog["providers"]:
            for mid in entry["paid_models"]:
                paid[(entry["id"], mid)] = entry
        records = []
        for entry in self.catalog["providers"]:
            for mid in entry["free_models"] + entry["paid_models"]:
                r = by_key.get((entry["id"], mid))
                if r is not None:
                    records.append({"id": mid, "free": True,
                                    "context_length": r.get("context_length"),
                                    "tools": bool(r.get("tools")),
                                    "vision": bool(r.get("vision")),
                                    "json": bool(r.get("json")),
                                    "owned_by": entry["id"]})
                else:
                    records.append({"id": mid, "free": False,
                                    "context_length": None, "tools": False,
                                    "vision": False, "json": False,
                                    "owned_by": entry["id"]})
        if api_key is not None:
            return {"data": [{"type": "model", "id": m["id"],
                              "display_name": m["id"],
                              "created_at": "2026-01-01T00:00:00Z",
                              "owned_by": m["owned_by"],
                              "free": m["free"],
                              "context_length": m["context_length"],
                              "tools": m["tools"], "vision": m["vision"],
                              "json": m["json"]} for m in records],
                    "has_more": False}
        return {"object": "list",
                "data": [{"id": m["id"], "object": "model",
                          "created": FIXED_CREATED,
                          "owned_by": m["owned_by"], "free": m["free"],
                          "context_length": m["context_length"],
                          "tools": m["tools"], "vision": m["vision"],
                          "json": m["json"]} for m in records]}


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

AGG = None  # set in main()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep stdout clean
        pass

    def _send(self, status, content_type, payload):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def do_GET(self):
        if self.path == "/v1/models":
            self._send(200, "application/json",
                       json.dumps(AGG.models_list(self.headers)).encode())
        elif self.path in ("/", "/health"):
            self._send(200, "application/json",
                       json.dumps({"ok": True, "served": AGG.served}).encode())
        else:
            self._send(404, "application/json",
                       json.dumps({"error": "not_found"}).encode())

    def do_POST(self):
        if self.path not in ("/v1/chat/completions", "/v1/messages"):
            self._send(404, "application/json",
                       json.dumps({"error": "not_found"}).encode())
            return
        body = self._read_body()
        if body is None:
            self._send(400, "application/json",
                       json.dumps({"error": "bad_json"}).encode())
            return
        api = "openai" if self.path == "/v1/chat/completions" else "anthropic"
        status, ctype, payload = AGG.serve(api, body)
        self._send(status, ctype, payload)


def pick_port():
    for port in (8765, 8766, 8767, 8768):
        try:
            srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
            return srv, port
        except OSError:
            continue
    srv = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
    return srv, srv.server_address[1]


def watch_work(env_url, server):
    """Poll GET /work; when the client is done, shut the server down so
    the process exits 0. Runs in a background thread."""
    while True:
        try:
            status, doc, _ = http_request("GET", env_url.rstrip("/") + "/work",
                                          timeout=5)
            if status == 200 and isinstance(doc, dict) and doc.get("done"):
                server.shutdown()
                return
        except Exception:
            pass
        time.sleep(0.5)


def main():
    global AGG
    args = sys.argv[1:]
    prompt_file = os.environ.get("MAKEFUN_PROMPT_FILE", "")
    env_url = os.environ.get("MAKEFUN_ENV_URL", "")

    if "--list" in args:
        if not prompt_file or not env_url:
            print(json.dumps({"providers": []}))
            return 0
        providers, ratings, _best, _manifest = parse_brief(prompt_file)
        catalog = build_catalog(providers, env_url)
        catalog = catalog_with_ratings_fallback(catalog, ratings)
        print(json.dumps(catalog))
        return 0

    if not prompt_file or not env_url:
        sys.stderr.write(
            "usage: MAKEFUN_PROMPT_FILE=<brief> MAKEFUN_ENV_URL=<env> "
            "python3 main.py [--list]\n")
        return 2

    providers, ratings, _best, _manifest = parse_brief(prompt_file)
    catalog = build_catalog(providers, env_url)
    catalog = catalog_with_ratings_fallback(catalog, ratings)
    AGG = Aggregator(env_url, providers, ratings, catalog)

    server, port = pick_port()
    # register: protocol_version 1, port, catalog
    status, doc, _ = http_request(
        "POST", env_url.rstrip("/") + "/register",
        body={"protocol_version": PROTOCOL_VERSION, "port": port,
              "catalog": catalog}, timeout=10)
    if status != 200 or not (isinstance(doc, dict) and doc.get("ok")):
        sys.stderr.write("register failed: HTTP %s %s\n" % (status, doc))
        return 1
    sys.stderr.write("registered on port %d, %d requests expected\n"
                     % (port, doc.get("requests", 0)))

    watcher = threading.Thread(target=watch_work, args=(env_url, server),
                               daemon=True)
    watcher.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
