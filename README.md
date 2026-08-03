# Message Notification Router (Multi-Agent Solution)

This directory contains the runnable solution for the HackerRank Orchestrate Message Notification Router challenge. It implements a robust, end-to-end multi-agent pipeline using TypeScript and the Claude Agent SDK.

# Pipeline Design
```mermaid

flowchart TD
    A["📨 Incoming Message<br/>Text / Image / Voice"] --> B["Context Builder<br/>User • Sender • Group • Business<br/>DND • Notification Load"]

    B --> C["🛡️ Safety Guard<br/>Phishing • Prompt Injection<br/>Domain Spoofing • Verification"]

    C --> D["🔎 Evidence Retriever<br/>Relevant Historical Messages<br/>Sender / Group / Business History"]

    D --> E{"Media Type?"}

    E -->|Text| F["Text Context"]
    E -->|Image| G["Image Context<br/>Claude Visual Analysis"]
    E -->|Voice| H["Local Whisper ASR<br/>Transformers.js"]

    H --> I["Voice Transcript<br/>Treated as Untrusted Content"]

    F --> J
    G --> J
    I --> J

    J["🤖 Primary Router<br/>Claude Sonnet 4.6<br/><br/>Structured RoutingDecision<br/>action • type • reason<br/>confidence • evidence IDs"]

    J --> K["✅ JSON Schema + Zod Validation"]

    K --> L["💾 Prediction Checkpoint"]

    L --> M{"needsReview()?"}

    M -->|"No"| N["Final Router Decision"]

    M -->|"Yes"| O["🔍 Reviewer<br/>Claude Sonnet 4.6<br/>Audit Router Decision"]

    O --> P{"Reviewer Verdict"}

    P -->|"Approve"| N

    P -->|"Challenge"| Q["⚖️ Judge<br/>Claude Opus 4.6<br/>Independent Final Decision"]

    Q --> R{"Valid Judge Output?"}

    R -->|"Yes"| S["Final Judge Decision"]
    R -->|"Failure"| N

    N --> T["💾 Final Prediction Cache"]
    S --> T

    T --> U["📄 output.csv<br/>notify / digest / mute"]

    V["scratch/predictions_cache.json"] -. "Resume / reuse" .-> L
    W["scratch/review_cache.json"] -. "Avoid repeated reviews" .-> O
    ```


## 🛠️ Setup Instructions

1. **Install Dependencies**
   Navigate to this `code/` directory in your terminal and install all required Node.js dependencies:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Create a `.env` file in the `code/` directory containing your Anthropic API Key:
   ```env
   ANTHROPIC_API_KEY=your_api_key_here
   ```

## 🚀 How to Run

To execute the pipeline and generate predictions for all 110 messages in `messages.csv`, run:
```bash
npx tsx src/main.ts --all
```
The orchestrator supports both fresh execution and checkpoint-based resume.

If a Router prediction already exists in:

```text
scratch/predictions_cache.json
```

the existing validated prediction is reused.

If a prediction does not exist, the orchestrator executes the complete routing pipeline for that message and immediately checkpoints the successful result. After routing, eligible predictions pass through the selective Reviewer and conditional Judge stages.

The final submission output is generated at:

```text
dataset/output.csv
```

### Other CLI Commands
* `npx tsx src/main.ts --limit 5` (Process only the next 5 uncached messages)
* `npx tsx src/main.ts --message-id msg_123` (Force a review of a specific message ID)
* `npx tsx src/main.ts --all --review-stats` (Perform a dry-run to see review gating metrics without making agent calls)

## 🧠 Architecture Overview

Our solution utilizes a deterministic safety layer combined with a Multi-Agent LLM pipeline to balance cost, speed, and accuracy.

### 1. Pre-Processing & Context
* **Context Builder** (`src/context-builder.ts`): Aggregates user profiles, group metadata, business verification, and DND states into a dense JSON payload.
* **Safety Guard** (`src/safety-guard.ts`): A deterministic heuristic layer that pre-flags known prompt injections, domain spoofing (e.g. `chase-secure-alert.com` instead of `chase.com`), and credential-harvesting patterns.
* **Evidence Retriever** (`src/evidence-retriever.ts`): Locates past messages from the sender to expose repeated chain-spam, duplicate promotions, or recurring scam behaviors.
* **Multimodal processing** (`src/multimodal.ts`): Uses **local Whisper** (`@xenova/transformers`) to transcribe voice notes completely locally, avoiding external API latency, while feeding local image paths directly into Claude's document reading capabilities. Note: Voice transcription requires the `@xenova/transformers` library (installed automatically via `npm install`).

### 2. Multi-Agent Decision Engine
Instead of relying on a single prompt, the system routes messages through three distinct tiers:

1. **Primary Router** (`src/router.ts`): A baseline agent (`claude-sonnet-4-6`) that processes the enriched context and outputs a strict Zod-validated `RoutingDecision`.
2. **Reviewer Gate** (`src/reviewer.ts`): A deterministic `needsReview` gate selects potentially ambiguous decisions, including `confidence < 0.80`, Router/safety disagreements, unsupported historical-evidence claims, and non-urgent notify decisions that conflict with DND rules. Eligible decisions are audited by the **Reviewer Agent** (`claude-sonnet-4-6`), which returns either an "approve" or "challenge" verdict.
3. **The Judge** (`src/judge.ts`): If (and only if) the Reviewer challenges the primary Router, the **Judge Agent** (`claude-opus-4-6`) is invoked. The Judge analyzes the original context, the Router's decision, and the Reviewer's critique to issue the final, binding routing decision.

# Checkpointing and Resume

Note: The scratch/ directory is intentionally not included in the submission ZIP because it contains runtime-generated checkpoints. On a fresh run, the orchestrator starts with an empty cache and automatically creates the directory and checkpoint files as predictions are generated.


The pipeline uses two primary checkpoint files:

```text
scratch/predictions_cache.json
scratch/review_cache.json
```

## Prediction Cache

```text
scratch/predictions_cache.json
```

stores successfully validated routing decisions.

The cache is written immediately after successful processing rather than waiting until the complete dataset finishes.

This protects progress if:

- an API rate limit is reached
- a model request fails
- the process is interrupted
- the machine or terminal session stops

When the pipeline is restarted, successfully completed predictions can be reused. If the prediction cache is missing or does not contain a particular message, the orchestrator automatically executes the Router for that message.

Therefore a clean environment can still execute:

```bash
npx tsx src/main.ts --all
```

and generate the complete output from scratch.
