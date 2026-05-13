# Heddle Risk-Tier Workflow

## 목적

이 문서는 Heddle이 작업을 받을 때 어떤 기준으로 위험도를 나누고, 어떤 gate를 켜야 하는지 정의합니다.

핵심 원칙:

- 낮은 위험 작업은 빠르게 끝냅니다.
- 코드 변경은 contract와 review를 요구합니다.
- side effect 작업은 explicit approval과 rollback을 요구합니다.
- 장기/고위험 작업은 traceability와 postmortem까지 요구합니다.

## Tier 정의

### Tier A: Quick / Local

대상:

- 단순 질문
- 짧은 조사
- 단일 파일 문서 수정
- 작은 문자열 수정
- 로컬 read-only 명령

필수 gate:

- `intent-summary`
- `completion-note`

worker:

- 기본적으로 사용하지 않습니다.
- 사용자가 명시적으로 위임을 요청하면 사용합니다.

산출물:

- 짧은 결과 보고
- 필요 시 memento decision/procedure

완료 기준:

- 사용자의 직접 요청에 답이 됨
- 수정이 있다면 파일 경로와 결과가 명확함

### Tier B: Code / Schema / Multi-file

대상:

- 다파일 코드 변경
- API route 변경
- schema 변경
- runtime behavior 변경
- MCP tool contract 변경
- CLI command behavior 변경

필수 gate:

- `acceptance`
- `contract`
- `forbidden-pattern-check`
- `codex-reviewer`

조건부 gate:

- `user-advocate`: 사용자 의도 이탈 위험이 있을 때
- `debater`: 설계 선택이 갈릴 때
- `phase-loop`: 단계형 작업일 때

worker:

- 독립 슬라이스가 명확하면 사용합니다.
- write set이 겹치면 병렬화하지 않습니다.

산출물:

- acceptance summary
- contract note
- reviewer PASS/FAIL
- changed files
- verification result

완료 기준:

- 구현이 끝남
- 검증이 통과함
- 사용자가 실제 확인할 수 있는 실행 경로가 있음

### Tier C: Side Effect / Operational

대상:

- 파일 삭제
- 데이터 삭제
- 계정 변경
- 서비스 재시작
- 배포
- 실제 주문/실거래
- 외부 결제
- 운영 설정 변경

필수 gate:

- `acceptance`
- `side-effect-classification`
- `rollback-memo`
- `explicit-approval`
- `dispatch-gate`
- `final-state-check`

조건부 gate:

- `codex-reviewer`: 코드나 설정 변경이 있으면 필수
- `user-advocate`: 목표 축소/방향 이탈 위험이 있으면 필수
- `postmortem`: 실패나 incident가 있으면 필수

worker:

- 준비 작업은 가능
- 실제 side effect 실행은 승인 전 금지

산출물:

- 승인 직전 상태
- 정확한 승인 문구 또는 마지막 명령
- rollback memo
- final state evidence

완료 기준:

- 승인 전이라면 실행 준비가 완료됨
- 승인 후라면 실제 적용값, 프로세스 상태, 유지 여부가 확인됨

### Tier D: Enterprise / Release / Compliance

대상:

- 공개 릴리즈
- 보안/인증/권한 변경
- 결제/과금 변경
- 규제성 변경
- 장기 multi-phase project
- 여러 repo 또는 여러 service에 걸친 변경

필수 gate:

- `spec-registry`
- `traceability-matrix`
- `phase-loop`
- `risk-register`
- `codex-reviewer`
- `user-advocate`
- `rollback-plan`
- `postmortem-or-release-note`

조건부 gate:

- `compliance-status`
- `cost-tracking`
- `feature-flag-or-canary`
- `backup-or-dr-check`

worker:

- 구현, 조사, 리뷰, user-advocate를 분리합니다.
- phase 단위로 PASS해야 다음 phase로 넘어갑니다.

산출물:

- spec
- phase plan
- traceability matrix
- risk register
- release note or postmortem
- run manifest

완료 기준:

- 각 phase acceptance 통과
- reviewer PASS
- user-advocate PASS
- final run/release state 확인

## Gate 상세

### `intent-summary`

사용자 요청을 한 줄 목표로 정리합니다.

예:

```text
Heddle에 risk-tiered governance workflow 문서를 추가한다.
```

### `acceptance`

완료 기준을 먼저 씁니다.

예:

```text
- Markdown 문서가 생성되어야 한다.
- Heddle에 적용할 개선 대상이 분명해야 한다.
- workflow, 장점, 구현 단계가 포함되어야 한다.
```

### `contract`

입출력과 side effect를 고정합니다.

예:

```text
Input: user request, selected flow, repo context
Output: runManifest, gateRecord, worker reports
Side effect: none until explicit approval for Tier C+
```

### `forbidden-pattern-check`

금지 패턴:

- 범위 밖 리팩터링
- 사용자 승인 없는 삭제
- silent fallback
- 테스트 통과만으로 완료 처리
- worker report 없이 위임 완료 처리
- running status를 done으로 취급
- riskTier 없이 side effect 실행

### `dispatch-gate`

위임 전에 남길 것:

```text
왜 worker가 필요한가?
어떤 파일/모듈이 worker 소유인가?
완료 기준은 무엇인가?
REPORT 형식은 무엇인가?
```

### `rollback-memo`

side effect 전 필수입니다.

필수 내용:

- 바뀌는 대상
- 되돌리는 명령 또는 절차
- 백업/현재값
- 승인 전 마지막 대기 지점

### `run-manifest`

run 전체를 묶는 요약입니다.

필수 내용:

- user request
- interpreted goal
- riskTier
- governancePack
- workers
- gates
- result
- trace id

## Leader 판단 알고리즘

```text
1. 요청을 읽는다.
2. 대상과 동사가 명확한지 확인한다.
3. side effect 여부를 판정한다.
4. 코드/API/schema/runtime 변경 여부를 판정한다.
5. riskTier를 고른다.
6. governancePack을 선택한다.
7. 직접 처리 또는 worker 위임을 결정한다.
8. gate를 실행한다.
9. 산출물을 저장한다.
10. 사용자에게 결과와 확인 경로를 보고한다.
```

## Tier별 기본 매핑

| Tier | 기본값 | 필수 gate | 대표 worker | 완료 보고 |
| --- | --- | --- | --- | --- |
| A.quick | direct-first | intent-summary | 없음 | 결과 요약 |
| B.code | direct or worker | acceptance, contract, reviewer | impl, reviewer | 파일/검증/실행 경로 |
| C.side_effect | approval-first | rollback, approval, final-state | analyst, reviewer, advocate | 승인/적용값/복구 경로 |
| D.enterprise | phase-first | spec, traceability, phase PASS | analyst, impl, reviewer, advocate | phase별 결과와 release state |

## Studio 표시 모델

Studio는 run detail 화면에서 다음을 보여줘야 합니다.

- Risk Tier badge
- Governance Pack name
- Gate timeline
- Worker tree
- REPORT cards
- Reviewer result
- User-advocate result
- Rollback memo
- Run manifest
- Traceability matrix는 Tier D에서만 표시

## 실패 처리

gate 실패 시 기본 규칙:

- reviewer FAIL: codex-fix 또는 구현 worker에게 surgical fix 할당
- user-advocate FAIL: 목표 해석 또는 결과물을 수정
- approval missing: side effect 실행 중지
- rollback missing: Tier C 이상 실행 중지
- worker timeout: status/report를 폴링하고, 하드 타임아웃이면 blocker로 보고

절대 하면 안 되는 것:

- FAIL을 무시하고 다음 phase로 진행
- worker가 running인데 완료 처리
- approval 없이 위험 작업 실행
- 사용자의 목표를 낮춰서 성공 처리
