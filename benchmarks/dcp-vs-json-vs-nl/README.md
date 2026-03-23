# DCP vs JSON vs Natural Language — Benchmark

Measures the practical cost differences between three data formats for AI agent communication:

- **DCP compact array**: Positional arrays with a shared schema line (Data Cost Protocol)
- **JSON (JSONL)**: Standard key-value JSON objects, one per line
- **Natural language**: Human-readable sentences describing the same data

## What is measured

| Axis | What | Why it matters |
|------|------|----------------|
| **Data size** | Bytes per record, total payload | Storage, network, context window cost |
| **Parse speed** | String → structured data (μs/record) | Processing overhead |
| **Overlay cost** | 3-domain temporal alignment | Quantum node simulation — stacking multi-agent data |
| **Token cost** | Estimated LLM tokens consumed | Direct API cost when feeding data to AI |

## Run

```bash
npm install
npx tsx bench.ts
```

Results are saved to `results/results.json` and `results/summary.md`.

## Key insight

DCP vs JSON is a modest size win (~40-50% smaller). The critical gap is **DCP vs Natural Language**: NL requires LLM inference to parse, adding orders of magnitude to processing cost. DCP and JSON parse with zero LLM cost.

For AI-to-AI communication (the receptor/Brain AI use case), natural language is the most expensive format by far — not because of bytes, but because of the inference cost to extract structure from it.

## Context

This benchmark supports the claims in [MULTI_AGENT_VISION.md](../../docs/MULTI_AGENT_VISION.md) and [DATA_COST_PROTOCOL.md](../../docs/DATA_COST_PROTOCOL.md) about the cost advantages of structured compact formats for multi-agent coordination.
