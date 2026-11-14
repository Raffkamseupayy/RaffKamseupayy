# Free AI Model Aggregator

One server that answers every request with the best **free** model that can
serve it, across ten simulated free-tier providers. Entry for the make.fun
bounty **free-model-aggregator-01** ("The best free AI model aggregator").

## What it does

- Serves the **OpenAI Chat Completions API** (`POST /v1/chat/completions`)
  and the **Anthropic Messages API** (`POST /v1/messages`), in JSON and in
  server-sent events (SSE), plus `GET /v1/models` in both wires' shapes.
- Reads the brief (`MAKEFUN_PROMPT_FILE`): the provider directory, the
  quality table (ratings), and the workload manifest.
- Discovers each provider's models from the provider itself and registers
  the catalog with the env (`POST $MAKEFUN_ENV_URL/register`).
- For each request it infers what the request needs (tools, vision, JSON
  mode, long context), ranks the free models by rating, and calls them in
  order until one answers — failing over on 402 (free allowance gone) and
  429 (rate limit). Exactly one provider call succeeds per request.
- Passes the request through faithfully (system prompt, user text, images,
  tools, stop sequences, max_tokens, JSON mode) and returns the provider's
  answer whole, with the provider's usage counts and stop reason mapped
  into the client's wire.
- Exits 0 when `GET $MAKEFUN_ENV_URL/work` says the workload is done.

Model calls are optional for this bounty, so this is a scripted
router/translator — no model of its own. Python 3.13, standard library
only, deterministic (no wall clock, no unseeded randomness).

## Run it

```bash
# in a trial (the env sets these):
MAKEFUN_PROMPT_FILE=<path to the brief> \
MAKEFUN_ENV_URL=<env base url> \
python3 main.py
```

List the catalog (the `--list` report) without starting the server:

```bash
MAKEFUN_PROMPT_FILE=<brief> MAKEFUN_ENV_URL=<env> python3 main.py --list
```

With no brief/env it prints `{"providers":[]}` and exits 0.
