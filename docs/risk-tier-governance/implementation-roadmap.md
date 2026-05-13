# Heddle Implementation Roadmap: Risk-Tiered Governance

## 목표

Heddle에 `riskTier`와 `governancePack` 기반 workflow를 추가합니다.

완료 상태는 다음과 같습니다.

```text
사용자 요청
  -> leader가 위험도 판정
  -> governancePack 자동 선택
  -> 필요한 worker/gate만 실행
  -> runManifest와 gateRecord 저장
  -> Studio에서 위험도, gate, report, rollback을 확인
```

## 구현 원칙

- 기존 Heddle의 local-first 방향을 유지합니다.
- low-risk 작업에 불필요한 문서 양식을 강제하지 않습니다.
- side effect 작업에는 승인과 rollback을 강제합니다.
- schema, runtime, Studio를 한 번에 크게 뒤집지 않습니다.
- 각 phase는 실제 실행 가능한 상태로 검증합니다.

## Phase 0: 현재 구조 확인

목표:

- 현재 flow schema, run event, trace-store, Studio run detail 구조를 확인합니다.
- 기존 삭제 상태나 dirty worktree를 건드리지 않습니다.

확인 대상:

- `packages/core/src/index.ts`
- `examples/leader-workers.yaml`
- `packages/mcp/src/tools.ts`
- `apps/server/src/trace-store.ts`
- `apps/server/src/index.ts`
- `apps/studio/src/AppSections.tsx`
- `apps/studio/src/store.ts`

Acceptance:

- riskTier를 넣을 schema 위치가 정해짐
- gate event를 저장할 trace path가 정해짐
- Studio에서 표시할 최소 위치가 정해짐

검증:

- read-only inspection
- 현재 test/build command 확인

## Phase 1: Core Schema 추가

목표:

- `RiskTier`, `GovernancePack`, `GateRecord`, `RunManifest` 타입과 schema를 추가합니다.

예상 변경:

- `packages/core/src/index.ts`

예상 타입:

```ts
export const riskTierSchema = z.enum([
  "quick",
  "code",
  "side_effect",
  "enterprise",
]);

export const gateStatusSchema = z.enum([
  "pending",
  "pass",
  "fail",
  "blocked",
  "skipped",
]);
```

Flow에 추가할 수 있는 형태:

```yaml
governance:
  defaultTier: quick
  packs:
    code-change-default:
      tier: code
      requiredGates:
        - acceptance
        - contract
        - reviewer
```

Acceptance:

- 기존 flow가 깨지지 않음
- governance 필드는 optional
- schema validation이 기존 examples를 통과

검증:

- `pnpm -r typecheck`
- core schema 관련 unit test
- existing flow load test

## Phase 2: Leader Policy 문서화 및 flow 연결

목표:

- `examples/leader-workers.yaml`에 risk-tier 판단 규칙을 명시합니다.
- leader가 작업 시작 시 riskTier와 gate를 짧게 고정하도록 합니다.

예상 변경:

- `examples/leader-workers.yaml`
- 필요 시 `skills/outcome-contract.yaml` 또는 새 skill

추가 규칙:

```text
작업 시작 전:
- riskTier를 판정한다.
- Tier B 이상이면 acceptance를 먼저 쓴다.
- Tier C 이상이면 rollback memo와 explicit approval 없이는 side effect를 실행하지 않는다.
- Tier D는 phase loop로 진행한다.
```

Acceptance:

- 기존 explicit delegation override 유지
- debate, phase loop, reviewer/fix loop 규칙과 충돌 없음
- low-risk 작업은 계속 direct-first 가능

검증:

- YAML schema validation
- prompt snapshot 또는 runner-prompt-builder test

## Phase 3: Gate Record 저장

목표:

- gate 통과/실패/차단을 trace event로 저장합니다.

예상 변경:

- `packages/core/src/index.ts`
- `apps/server/src/trace-store.ts`
- `apps/server/src/index.ts`

Gate event 예시:

```json
{
  "type": "gate_record",
  "gate": "codex-reviewer",
  "status": "pass",
  "reason": "No regression found",
  "evidence": ["apps/server/src/index.ts:492"]
}
```

Acceptance:

- 기존 run event 저장과 호환
- gate event가 run detail API에서 조회됨
- event stream으로 Studio가 받을 수 있음

검증:

- server test에 append-only 방식으로 추가
- `GET /runs/:id/events`에서 gate event 확인

## Phase 4: Run Manifest 생성

목표:

- run 단위로 request, interpretedGoal, riskTier, governancePack, workers, gates, result를 묶습니다.

예상 변경:

- `apps/server/src/trace-store.ts`
- `apps/server/src/index.ts`
- 필요 시 `packages/runtime`

Manifest 최소 필드:

```json
{
  "runId": "...",
  "request": "...",
  "interpretedGoal": "...",
  "riskTier": "code",
  "governancePack": "code-change-default",
  "gates": [],
  "workers": [],
  "result": "running"
}
```

Acceptance:

- run 시작 시 manifest 생성
- gate event 발생 시 manifest summary 갱신 가능
- run 종료 시 final result 저장

검증:

- `POST /runs/register`
- `POST /runs/:id/events`
- `GET /runs/:id`
- `GET /runs/:id/events`

## Phase 5: MCP Gate Tool 최소 추가

목표:

- leader 또는 worker가 gate record를 남길 수 있는 MCP tool을 제공합니다.

후보 tool:

- `heddle_record_gate`
- `heddle_read_manifest`
- `heddle_update_manifest`
- `heddle_require_approval`

초기 최소안:

- `heddle_record_gate` 하나만 먼저 추가
- manifest는 server event에서 조립

Acceptance:

- tool schema가 typed argument를 가짐
- invalid status/gate는 거부
- report path와 run id를 연결 가능

검증:

- MCP initialize
- tool list
- tool call with valid gate
- tool call with invalid gate should fail

## Phase 6: Studio 표시

목표:

- run detail에서 risk tier와 gate timeline을 볼 수 있게 합니다.

예상 변경:

- `apps/studio/src/store.ts`
- `apps/studio/src/AppSections.tsx`
- 필요 시 CSS

UI 구성:

- Run header: Risk Tier badge
- Left tree: worker tree 유지
- Center timeline: gate events 표시
- Right panel: selected gate detail, report, rollback memo

Acceptance:

- 기존 run detail UI가 깨지지 않음
- gate event가 없으면 기존 방식으로 표시
- gate event가 있으면 timeline에 표시

검증:

- Studio dev server 실행
- sample run events 확인
- desktop screenshot 또는 browser smoke

## Phase 7: Tier C Approval Boundary

목표:

- side effect 작업은 explicit approval 전에는 실행되지 않도록 합니다.

대상:

- 삭제
- 배포
- 계정 변경
- 결제
- 실거래
- 데이터 변경
- 서비스 재시작

Leader 규칙:

```text
Tier C 이상이면:
1. 실행 계획 작성
2. 현재 상태/백업/rollback memo 작성
3. 사용자의 명시 승인 대기
4. 승인 후 실행
5. final state 확인
```

Acceptance:

- 승인 전 side effect 실행 금지
- 승인 문구 또는 마지막 명령이 명확함
- 승인 후 final state evidence가 남음

검증:

- prompt behavior test
- manual dry-run scenario

## Phase 8: Documentation and Examples

목표:

- 사용자가 바로 이해할 수 있는 예제를 추가합니다.

문서:

- risk tier guide
- governance pack examples
- side effect approval examples
- Studio run detail explanation

예제 flow:

- `examples/leader-workers.yaml` 유지
- 필요 시 `examples/risk-tier-workers.yaml` 추가

Acceptance:

- 기본 flow가 너무 무거워지지 않음
- 새 example은 optional
- README는 현재 구현과 과장 없이 일치

검증:

- docs link check
- flow load
- smoke run

## 추천 구현 순서

가장 좋은 순서:

1. Core schema
2. leader policy
3. gate event 저장
4. run manifest
5. Studio 표시
6. approval boundary 강화
7. docs/examples

이 순서가 좋은 이유:

- schema가 먼저 있어야 server/studio가 같은 언어를 씁니다.
- leader policy만 먼저 바꾸면 trace와 UI가 못 따라옵니다.
- Studio를 먼저 만들면 표시할 데이터가 없습니다.
- approval boundary는 policy와 event 저장이 있어야 강제력이 생깁니다.

## 최소 MVP

한 번에 다 하지 않을 경우 MVP는 이것입니다.

```text
Core:
  RiskTier + GateRecord type

Leader:
  riskTier 판정 규칙

Server:
  gate_record event 저장

Studio:
  gate event timeline 표시
```

MVP에서 제외:

- full traceability matrix
- compliance registry
- cost tracking
- feature flag/canary
- backup/DR
- RACI

## 성공 기준

이 개선이 성공했다는 기준:

- 단순 작업은 이전처럼 빠르게 끝납니다.
- 코드 변경은 acceptance와 reviewer 결과가 남습니다.
- 위험 작업은 승인 전 실행되지 않습니다.
- run detail에서 risk tier와 gate 결과를 볼 수 있습니다.
- worker REPORT와 gateRecord가 같은 run 안에서 연결됩니다.
- 실패한 작업은 memento에 원인/해결 절차가 남습니다.

## 실패 기준

다음 상태면 개선 실패입니다.

- 모든 작업이 문서 템플릿으로 느려짐
- low-risk 작업에도 reviewer가 강제됨
- side effect 작업인데 rollback memo 없이 진행됨
- worker 결과가 report 없이 사라짐
- gate 실패를 무시하고 다음 phase로 넘어감
- Studio에 데이터가 너무 많아져서 핵심 판단이 안 보임
