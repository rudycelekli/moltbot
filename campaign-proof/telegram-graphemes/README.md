# Telegram whole-grapheme proof handoff — PR #166567

**Prepared, not run.** No Telegram credential was leased, no dependency was
installed, and no secret-bearing Gateway or channel was started for this handoff.
The approved broker and trusted execution host are unavailable. Root owns access
readiness, the real run, final gates, and any upstream update.

Target: `0216d75b6508a9db7dcd08ade81dd8f80482bd2a` exactly.
Review request: https://github.com/openclaw/openclaw/pull/166567#issuecomment-6036672252.
Existing subscription callback tests are supplemental; this procedure must produce
real Telegram Test Server messages observed by the leased TDLib user.

## Maintained route and fixture

Use the target checkout's `.agents/skills/telegram-e2e-userbot/SKILL.md`,
`features/README.md`, `features/delivery-lifecycle.md`, and
`features/runtime-reference.md`. The runner is
`scripts/run-mock-sut-user-e2e.mjs` under that skill. Use its `mock` backend and
the existing `scripts/e2e/mock-openai-server.mjs`; no alternate server, transport
stub, injected reply callback, API hold/rejection, or production change is needed.

`fixture/prepare-control.mjs` is an offline, standard-library-only generator. It
writes a fresh `MOCK_RESPONSE_CONTROL` model map for the runner's `gpt-5.5`, a
single-send scenario, and an independent source manifest. The maintained mock
accepts explicit Responses events and serves them as SSE. Its custom-event path
does **not** honor `chunkDelayMs`: these are deterministic event deltas, not a
claim about pacing or progressive screenshots. Each delta contains complete
Unicode code points; width 1 splits the family/accent/flag across deltas without
ever splitting a surrogate pair. Width 17 is the second fragmentation control.
The response carries `phase: final_answer`, matching the subscription producer.

The marker is inside the fixed ASCII prefix, so it does not shift the cut.
Never reuse a run label or overwrite an old proof directory.

| Case | ASCII UTF-16 prefix | Focus | Total UTF-16 units | Purpose |
| --- | ---: | --- | ---: | --- |
| `family` | 1195 | 👨‍👩‍👧‍👦 (11) | 1210 | Actual family crossing at 1200 |
| `accent` | 1199 | e + U+0301 (2) | 1205 | Actual accent crossing |
| `flag` | 1198 | 🇨🇦 (4) | 1206 | Actual flag crossing |
| `accent-fit` | 1195 | e + U+0301 (2) | 1201 | Accent fits before the cut |
| `flag-fit` | 1195 | 🇨🇦 (4) | 1203 | Flag fits before the cut |
| `ascii` | 1195 | ABCD (4) | 1203 | Bounded ordinary prose control |
| `family-short` | 100 | 👨‍👩‍👧‍👦 (11) | 115 | Below-minimum terminal drain control |

Every source ends in literal `done`. The requested 1195 prefix crosses the family
only; treating the same-prefix accent/flag as forced-cut failures would be false.

## Preparation owned by the trusted operator, before any lease

Use a clean, fully materialized checkout and dependency-ready **built** runtime
for the exact target. Prepare/build through the owner's normal approved process,
outside any credential lease; this handoff neither installs nor builds. Record
Node/pnpm/Gateway/TDLib versions, the build's source/tree identity, and hashes of
the reached chunker/core/Telegram/provider artifacts. Merely testing the current
Git HEAD while using an older `dist` is insufficient. The maintained driver pins
`@prebuilt-tdlib` 0.1008067.0, reporting TDLib 1.8.67. Prepare that binary before
leasing, preserving the driver's confinement. Do not auto-download during proof.

Use only the owner-provided broker route and approved egress/runtime. Do not
discover/reuse personal sessions, log in, change broker deployment/config, or
install a CLI to obtain access. The standalone doctor also leases credentials:
do not execute it before access is approved, and a released doctor lease does not
qualify the later runner. Each runner performs readiness on its own lease.

Set these public paths/ports on the trusted host (paths below are placeholders):

```sh
cd "$OPENCLAW_EXACT_CHECKOUT"
test "$(git rev-parse HEAD)" = 0216d75b6508a9db7dcd08ade81dd8f80482bd2a
test -z "$(git status --porcelain)"
test -f dist/entry.js
command -v node
command -v uv
node --version
export TELEGRAM_E2E_SKILL_DIR="$PWD/.agents/skills/telegram-e2e-userbot"
: "${HANDOFF_DIR:?absolute path to this handoff}"
: "${TELEGRAM_GATEWAY_PORT:?owner-selected unused Gateway port}"
: "${TELEGRAM_MOCK_PORT:?owner-selected distinct unused provider port}"
: "${TELEGRAM_USER_DRIVER_TDLIB_PATH:?preprepared read-only TDLib binary}"
export TELEGRAM_USER_DRIVER_TDLIB_PATH
: "${TELEGRAM_E2E_PROOF_ROOT:?absolute private durable directory outside scratch}"
```

Owner privately supplies an already approved broker pair or authenticated existing
launcher. Do not print credential values or include them in commands/artifacts.
Check the chosen ports have no listeners without killing another user's process.

## Exact real run, once approved

The example drives `family` with one-code-point deltas. Set a fresh public
8–32-character uppercase alphanumeric `RUN_LABEL` for each invocation. Repeat separately for
`accent`, `flag`, fitting/ASCII/short controls, then crossing cases at width 17.
Run serially, judge and clean up each run before the next; do not rotate unchanged
credentials or retry an uncertain send to obtain a pass.

```sh
umask 077
: "${RUN_LABEL:?fresh public uppercase alphanumeric run label}"
CASE=family
WIDTH=1
CASE_DIR="$TELEGRAM_E2E_PROOF_ROOT/${CASE}-${WIDTH}-${RUN_LABEL}"
node "$HANDOFF_DIR/fixture/prepare-control.mjs" "$CASE" "$RUN_LABEL" "$CASE_DIR" "$WIDTH"
export MOCK_RESPONSE_CONTROL="$CASE_DIR/control.json"
export E2E_TELEGRAM_PROVIDER_API=openai-responses
export E2E_ROOT_CONFIG_PATCH='{"agents":{"defaults":{"blockStreamingDefault":"on","blockStreamingBreak":"text_end","blockStreamingChunk":{"minChars":800,"maxChars":1200,"breakPreference":"paragraph"}}}}'
export E2E_TELEGRAM_CONFIG_PATCH='{"richMessages":false,"responsePrefix":"","streaming":{"mode":"partial","chunkMode":"length","block":{"enabled":true,"coalesce":{"minChars":800,"maxChars":1200,"idleMs":1000}}}}'
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --backend mock --dm \
  --gateway-port "$TELEGRAM_GATEWAY_PORT" --mock-port "$TELEGRAM_MOCK_PORT" \
  --timeout-ms 60000 --scenario "$CASE_DIR/scenario.json" \
  --record "$CASE_DIR/events.ndjson" --output "$CASE_DIR/summary.json" \
  > "$CASE_DIR/runner-report.json" 2> "$CASE_DIR/runner.stderr.log"
RUN_EXIT=$?
printf '%s\n' "$RUN_EXIT" > "$CASE_DIR/runner.exit"
```

Check actual exit status immediately. A successful recorder does not itself
assert the requested delivery. Judge the native artifacts below.

**Why these settings:** The exact Telegram draft owner forces
`disableBlockStreaming=true` when `streaming.mode` is `off`, so `off` cannot prove
this PR. `partial` with explicit `block.enabled=true` keeps stream delivery active
while disabling the answer preview; durable core blocks reach the channel. Root
chunking is the ordinary 800/1200 paragraph configuration. Coalescer max 1200
prevents overflow blocks being folded into one 4096-unit message; idle/minimum are
retained. Plain classic text delivery avoids an unrelated rich-tree extraction
variable. Neither channel text limit nor chunker cap is enlarged. The final
small remainder is allowed below 800; minimum size is not a final-drain floor.

## Required evidence and independent judgment

Keep the entire raw run private. Inspect the following, then export only bounded,
redacted facts and fixture text. Raw NDJSON, config, logs, readiness/session paths,
IDs, username/chat/account identities and provider request bodies are not public.

1. Confirm exact source/build identity and readiness for the selected SUT/user,
   Test Server (`testDc: true`), approved transport and TDLib 1.8.67. Confirm
   `sut-config.json` has the intended root/channel settings and mock base URL.
2. Require `recordingComplete: true`, runner success, and the fresh scenario's
   completed send action. Anchor all evidence after that action; exclude cached
   replay. One isolated DM/send per run makes later fixture messages attributable.
3. Require the matching `/v1/responses` `gpt-5.5`, streaming model request in
   `mock-openai-requests.ndjson`, containing this run's prompt marker. Inspect
   inference purpose: activity recap or extra inference must not stand in for
   the user's answer. Unexpected requests/answers make attribution unresolved;
   retain them rather than silently dropping them. Preserve control-file hash
   and delta count/code-point validity from the offline receipt.
4. For this marker-correlated answer, inspect each raw `updateNewMessage`'s
   native formatted-text tree and normalized `message` rows with `isSut: true`.
   Follow edits/deletes by raw TDLib ID in this same authorized user's chat.
   `summary.timeline` omits text: obtain actual text from NDJSON (or associate
   revision arrays correctly). `updateMessageEdited` alone is not content proof.
5. Read the final persistent SUT text messages in delivery order. Require their
   concatenation **without inserting separators** to equal `expected.json.text`
   exactly: no loss, duplication, extra paragraph separator or extra final copy.
   Require every delivered fixture message's JS `text.length` <=1200. Recorder
   `textLen` is Python code-point length, not the UTF-16 cap metric.
6. Independently segment the expected source with native `Intl.Segmenter` using
   `granularity: "grapheme"`. Each cumulative message boundary must be one of
   those source offsets. Require the complete focus character once in exactly
   one message, without a message boundary inside it. Do not derive expected
   boundaries with the changed chunker/normalization helper. ASCII focus is four
   ordinary graphemes, so apply the whole-source boundary/cap checks without
   asserting ABCD is one cluster. The short-family control must fully drain in
   one persistent reply despite being below 800.
7. The long fixtures must produce more than one persistent answer message;
   otherwise the claimed 1200 block-delivery route is not established. Check
   the scenario proxy log has no request holds/rejections. Native TDLib delivery
   is decisive: a Gateway outbound log or synthetic callback is insufficient.

For the crossing fixtures, the expected candidate split is before the focus:
family 1195 + 15, accent 1199 + 6, flag 1198 + 8 UTF-16 units. These lengths are
diagnostic expectations, not a substitute for inspecting actual source continuity,
caps and native message boundaries. If a downstream owner changes delivery, retain
the observed result and explain it rather than forcing this shape into a verdict.

Export a small public report with candidate SHA/build manifest, fixture case and
delta width, provider request count/purpose, sent-action success, run-local message
labels, each relevant fixture text/tree and measured UTF-16 length, cumulative
boundaries, whole-cluster/cap/source-continuity verdicts, and cleanup confirmations.
No raw native identity or private path. This is nonvisual textual correctness proof;
any screenshot must be from an actual authorized Telegram client, redacted, not a
reconstructed chat. Root can then update the PR body and request fresh review.

## Cleanup and failure

The runner owns lease, Test Bot API adapter, mock provider, fresh Gateway,
recorder, process groups and credential scratch. Require verified stopped owned
processes/listeners, confirmed lease release, credential scratch removal, and
readable retained proof. A field claiming scratch removal alone is insufficient
when teardown failed. Unconfirmed cleanup means failure/unknown, not completion.

Preserve shared chats, membership, fixtures and unrelated messages. If removing
run-owned Telegram messages, use actual account-scoped receipts while that same
lease remains valid; preserve events first and verify deletion. Never use the
historical `botApiMessageId` projection for cross-account DM cleanup. Routine
runner teardown does not by itself prove Telegram message deletion.
Do not attempt message deletion after the runner has released its lease using
saved sessions. If the owner requires deletion before release, arrange that in
the maintained run scope; this handoff contains no ad hoc post-release mutation.

On failed/uncertain send, keep passive observations and reconcile owned state;
do not resend. On cancellation, heartbeat failure or rejected authority, stop new
actions. If cleanup retains private recovery state, the same credential owner may
use the maintained `telegram-test-recover.mjs "$TELEGRAM_RETAINED_LEASE_DIR" status`
under the original temporary root and revalidated authority. Do not create a new
lease or use a saved TDLib session to bypass that refusal. Retained lease receipts
are secrets and must never be uploaded. Follow runtime-reference recovery rules.

After verified shutdown, clear public fixture/config environment variables from
the operator shell. Keep durable private evidence until review completes; publish
only the consciously sanitized report. This handoff has performed none of the
live steps or cleanup claims above.

## Handoff validation completed

`offline-validation.json` records all seven fixture cases at code-point widths
1 and 17: 14 pure generator validations passed on Node 24.19.0, including source
reconstruction, no surrogate-valued code points, final event text/phase, exact
UTF-16 lengths and crossing/control distinctions. No repository server, runner,
parser, Gateway or TDLib code was executed for these checks.

The exact repository autoreview tool reviewed the actual generator in an
isolated fixture-only Git scope: `review/autoreview-status.json` reports
`scoped-clean`, exit 0, through P2. That is a static fixture assessment only.
`source-map.json` pins all maintained source references to the candidate and
records the production worktree as clean. No fixture Git metadata or handoff
payload belongs in the upstream PR.
