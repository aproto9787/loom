# Heddle Improvement Spec: Risk-Tiered Governance Workflow

## 결론

Heddle을 개선할 방향은 `문서 양식 48개를 기본 강제하는 시스템`이 아닙니다.

Heddle 안에 `riskTier`와 `governancePack`을 넣고, 작업 위험도가 올라갈 때만 필요한 gate를 자동으로 켜는 구조가 맞습니다.

이 방향이 맞는 이유:

- Heddle의 정체성은 local control plane입니다.
- 사용자는 빠르게 실행하고, 실제 결과를 확인해야 합니다.
- 다만 삭제, 계정 변경, 운영 반영, 실거래, 대규모 코드 변경처럼 위험한 작업은 흔적과 승인 경계가 필요합니다.
- 따라서 기본값은 가볍게 두고, 위험 작업에서만 DoD, contract, review, rollback, traceability를 강제해야 합니다.

관련 이미지:

- [개선 대상 이미지](./image-set/01-heddle-improvement-targets.png)
- [위험도 판정 이미지](./image-set/02-risk-tier-decision.png)
- [개선 후 실행 흐름 이미지](./image-set/04-improved-execution-flow.png)

## 현재 Heddle 워크플로우 요약

현재 Heddle은 이미 좋은 뼈대를 갖고 있습니다.

핵심 흐름:

1. 사용자가 로컬에서 Heddle을 실행합니다.
2. YAML flow를 선택합니다.
3. host leader session이 사용자의 실제 요청을 받습니다.
4. Heddle MCP가 run-scoped delegation tool을 주입합니다.
5. leader는 필요할 때 worker에게 위임합니다.
6. worker는 격리된 세션에서 작업하고 REPORT를 반환합니다.
7. run event와 report는 trace DB에 남습니다.
8. Studio는 flow, role, run history, report를 보여줍니다.

이미 있는 강점:

- `heddle_delegate_many`로 병렬 worker dispatch 가능
- `user-advocate`로 사용자 의도 검증 가능
- `codex-reviewer`와 `codex-fix`로 review/fix loop 가능
- debate 요청은 `debater-a`, `debater-b`, `synthesizer`로 분리 가능
- phase 요청은 phase acceptance를 먼저 잡고 단계별로 진행 가능
- MCP delegation을 통해 leader와 worker 사이 경계가 명확함

현재 부족한 점:

- 작업 위험도 판정이 구조화된 데이터로 남지 않습니다.
- 어떤 작업에 어떤 gate를 켜야 하는지 flow schema에 명시되어 있지 않습니다.
- `DoD`, `API Contract`, `Rollback memo`, `Dispatch approval` 같은 운영 체계가 leader prompt 규칙에 흩어질 가능성이 있습니다.
- trace DB는 실행 기록을 저장하지만, gate 통과/차단 이유를 first-class record로 다루지는 않습니다.
- Studio에서 "왜 이 작업이 위험했고 어떤 gate를 통과했는지"를 바로 보기 어렵습니다.

## 가져올 체계와 버릴 체계

아까 자료의 핵심은 "AI coding에는 운영 체계가 필요하다"입니다.
다만 Heddle에 그대로 전부 넣으면 무거워집니다.

### 바로 가져올 것

`DoD / Acceptance Criteria`

- 작업 시작 전에 완료 기준을 짧게 고정합니다.
- phase 작업과 review gate의 기준이 됩니다.
- "테스트 통과"가 아니라 "사용자가 실제 확인 가능한 상태"까지 포함해야 합니다.

`API Contract / Interface Contract`

- 코드, 스키마, MCP tool, server route, CLI command 변경에서 필수입니다.
- 입력, 출력, 에러 형태, side effect를 명시합니다.

`Forbidden Pattern Detector`

- 범위 밖 리팩터링, silent fallback, 무단 삭제, 승인 없는 side effect를 막습니다.
- 처음에는 정적 분석 엔진이 아니라 rule checklist로 시작해도 됩니다.

`Dispatch Gate`

- worker를 부르기 전, 왜 직접 처리하지 않고 위임하는지 남깁니다.
- 위험 작업에서는 user-advocate/reviewer를 자동으로 붙입니다.

`Run Manifest`

- 한 run의 요청, riskTier, gate, worker, report, trace id를 묶습니다.
- 나중에 "이 작업이 왜 이렇게 처리됐는지"를 복원합니다.

`Rollback Memo`

- 파일 수정, 설정 변경, 서비스 재시작, 계정 변경, 삭제, 실거래 직전에는 되돌리는 방법을 기록합니다.
- 승인 전 준비 단계와 승인 후 실행 단계를 분리합니다.

`Postmortem / Learning Memory`

- 실패 원인, 해결 절차, 재발 방지 규칙을 memento에 남깁니다.
- 같은 실패를 다시 조사하지 않게 합니다.

### 조건부로 가져올 것

`Traceability Matrix`

- 고위험 작업, 여러 worker, 장기 phase, release 작업에서만 켭니다.
- 일반 단일 파일 수정에는 과합니다.

`Spec Registry`

- 큰 기능, multi-phase, 사용자 승인이 필요한 작업에서만 씁니다.
- 작은 수정은 acceptance 한 줄이면 충분합니다.

`ADR`

- 아키텍처 선택이 있는 경우에만 씁니다.
- 단순 구현이나 스타일 수정에는 불필요합니다.

`Compliance Status Registry`

- 보안, 결제, 실거래, 계정, 외부 공개, 규제성 작업에서만 씁니다.

`Cost Tracking`

- 장기 agent orchestration, 대량 subagent, 외부 API 비용이 실제 문제가 될 때만 씁니다.

### 기본 OFF로 둘 것

- 전면 RACI
- 전면 DR/Backup
- 전면 Logging/Metrics/Tracing/Alerting
- 모든 작업에 대한 Spec DAG
- 모든 작업에 대한 Compliance Registry
- 모든 작업에 대한 Feature Flag/Canary

이 항목들은 enterprise/high-risk tier에서는 의미가 있지만, Heddle 기본 사용 경험에 깔면 속도를 죽입니다.

## Heddle에 넣을 핵심 개념

### `riskTier`

작업 위험도입니다.

권장 tier:

- `A.quick`: 짧은 질답, 단일 파일 수정, 단순 명령, 문서 소폭 수정
- `B.code`: 다파일 코드 변경, API/schema 변경, runtime behavior 변경
- `C.side_effect`: 설정 변경, 서비스 재시작, 데이터 삭제, 계정 변경, 배포, 실거래
- `D.enterprise`: 공개 release, 보안/결제/규제성 변경, 장기 multi-phase 작업

### `governancePack`

riskTier별로 자동으로 켜지는 gate 묶음입니다.

예시:

```yaml
governancePack:
  tier: B.code
  requiredGates:
    - acceptance
    - api-contract
    - forbidden-pattern-check
    - codex-reviewer
  optionalGates:
    - user-advocate
    - run-manifest
```

### `gateRecord`

각 gate가 왜 통과했거나 차단됐는지 남기는 기록입니다.

필수 필드:

```yaml
gateRecord:
  gate: codex-reviewer
  status: pass
  reason: "No behavior regression found in changed route and tests pass."
  evidence:
    - "apps/server/src/index.ts:492"
    - "apps/server/src/index.test.ts:120"
```

### `runManifest`

한 작업 전체의 실행 기록입니다.

필수 필드:

```yaml
runManifest:
  request: "사용자 원 요청"
  interpretedGoal: "leader가 정규화한 목표"
  riskTier: B.code
  governancePack: code-change-default
  workers:
    - codex-impl-1
    - codex-reviewer
  gates:
    - acceptance
    - api-contract
    - review
  result: pass
  traceId: "run id 또는 trace db key"
```

## 개선된 작업 흐름

### 1. 요청 정규화

사용자의 짧은 요청을 leader가 한 줄 목표로 정규화합니다.

예:

```text
원 요청: 이거 개선 ㄱㄱ
해석: Heddle workflow에 risk-tiered governance pack을 문서화하고 구현 계획을 만든다.
```

모호하면 실행하지 않고 질문합니다.
명확하면 바로 진행합니다.

### 2. risk tier 판정

leader가 작업 위험도를 먼저 판정합니다.

판정 기준:

- 파일 수정이 있는가
- 다파일 변경인가
- API/schema/runtime 동작이 바뀌는가
- 서비스, 설정, 계정, 데이터, 외부 요청 side effect가 있는가
- rollback이 필요한가
- 사용자 체감 실행 검증이 필요한가

### 3. governance pack 선택

riskTier에 따라 gate를 자동 선택합니다.

예:

- A: acceptance summary만
- B: acceptance + contract + reviewer
- C: acceptance + rollback + explicit approval + reviewer + user-advocate
- D: spec + traceability + phase loop + reviewer + user-advocate + postmortem

### 4. leader orchestration

leader는 직접 처리할지, worker를 부를지 결정합니다.

직접 처리:

- 단순 질답
- 단일 파일 소폭 수정
- 짧은 명령 실행
- 낮은 위험 문서 수정

worker 위임:

- 독립 슬라이스가 2개 이상
- frontend/backend/review/research처럼 전문 역할이 있음
- 사용자가 위임, worker, agent, 팀, 병렬을 명시
- broad investigation이 필요
- 구현 후 별도 검증 이득이 큼

### 5. gate 실행

작업 중 gate를 순서대로 실행합니다.

권장 순서:

1. acceptance gate
2. contract gate
3. implementation or investigation
4. forbidden pattern gate
5. reviewer gate
6. user-advocate gate
7. run manifest finalization
8. memento reflect

### 6. 산출물 저장

작업 후 자동으로 남길 것:

- worker REPORT
- reviewer PASS/FAIL
- user-advocate PASS/FAIL
- runManifest
- gateRecord
- rollbackMemo
- trace DB event
- memento decision/error/procedure

## 장점

### 1. 빠른 작업은 계속 빠릅니다

모든 요청에 큰 문서 템플릿을 강제하지 않습니다.
단순 작업은 지금처럼 바로 처리합니다.

### 2. 위험 작업만 엄격해집니다

삭제, 배포, 계정 변경, 실거래, 데이터 손상 가능 작업은 승인과 rollback을 요구합니다.
이건 속도를 늦추는 게 아니라 사고를 막는 장치입니다.

### 3. worker 위임이 더 투명해집니다

누가 어떤 작업을 맡았는지, 왜 worker가 필요했는지, 어떤 report가 돌아왔는지 남습니다.

### 4. review 기준이 흔들리지 않습니다

reviewer는 막연히 "봐줘"가 아니라 acceptance와 contract 기준으로 검토합니다.

### 5. user-advocate가 더 정확해집니다

사용자 원 요청, riskTier, acceptance, 실제 결과를 비교할 수 있으므로 목표 축소와 방향 이탈을 더 잘 잡습니다.

### 6. 같은 실패를 반복하지 않습니다

에러 원인과 해결 절차가 memento와 trace에 남습니다.
다음 세션에서 다시 조사하지 않고 바로 재사용할 수 있습니다.

### 7. Studio가 단순 로그 뷰어를 넘어서게 됩니다

Studio가 run history만 보여주는 것이 아니라, risk tier, gate 통과 여부, worker report, rollback memo까지 보여줄 수 있습니다.

## 구현 대상 요약

### `packages/core`

추가할 것:

- `RiskTier` enum
- `GovernancePack` schema
- `GateRecord` schema
- `RunManifest` schema
- flow validation rule

### `examples/leader-workers.yaml`

추가할 것:

- risk tier 판정 규칙
- tier별 required gate 규칙
- side effect 승인 경계
- gate failure 시 fix/review loop 규칙

### `packages/mcp`

추가할 것:

- `heddle_record_gate`
- `heddle_get_run_manifest`
- `heddle_update_run_manifest`
- `heddle_require_approval`

초기에는 꼭 tool을 많이 만들 필요는 없습니다.
우선 trace event 형태로 저장하고, tool surface는 필요한 것부터 추가하면 됩니다.

### `apps/server`

추가할 것:

- run manifest persistence
- gate record persistence
- run detail API에 gate summary 포함
- event stream에 gate event 추가

### `apps/studio`

추가할 것:

- run detail 화면의 Risk Tier badge
- Gate timeline
- Worker report cards
- Rollback memo panel
- Traceability view는 Tier D에서만 노출

## 비목표

이번 개선의 비목표:

- Heddle을 Jira/Linear 같은 project management tool로 바꾸는 것
- 모든 작업에 Spec Registry를 강제하는 것
- 모든 worker output을 대형 문서로 만드는 것
- 모든 low-risk 작업에 reviewer를 강제하는 것
- enterprise compliance 제품으로 방향을 바꾸는 것

## 최종 판단

Heddle은 "AI coding용 운영 체계"를 흡수해야 합니다.
하지만 흡수 방식은 checklist 복붙이 아니라 runtime workflow로 녹이는 방식이어야 합니다.

가장 좋은 최종 형태:

```text
사용자 요청
  -> leader가 목표와 위험도 판정
  -> riskTier에 맞는 governancePack 선택
  -> 필요한 worker와 gate만 실행
  -> report / gateRecord / runManifest / memory 저장
  -> Studio에서 결과와 이유를 확인
```

이 구조가 Heddle의 현재 방향과 제일 잘 맞습니다.
