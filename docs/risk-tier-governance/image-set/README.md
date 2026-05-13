# Heddle Improvement Image Set

이 폴더는 Heddle 개선안을 설명하는 이미지 모음입니다.

보기 순서:

1. `01-heddle-improvement-targets.png`
   - Heddle에 정확히 무엇을 개선할지 설명합니다.
   - 대상: Flow Schema, Leader Policy, MCP Gate Tools, Trace Store, Studio View.

2. `02-risk-tier-decision.png`
   - 작업을 A/B/C/D 위험도로 나누는 기준을 설명합니다.
   - 낮은 위험 작업은 빠르게, 위험 작업은 gate를 강하게 적용합니다.

3. `03-governance-packs.png`
   - 아까 자료에서 가져올 운영 체계를 Heddle risk tier별로 매핑합니다.
   - 48개 체계를 전부 기본 강제하지 않고 필요한 것만 켭니다.

4. `04-improved-execution-flow.png`
   - 개선 후 실제 실행 흐름을 보여줍니다.
   - 요청 → 위험도 판정 → contract → leader orchestration → MCP boundary → gate loop → trace/Studio.

5. `05-benefits-and-outcomes.png`
   - 개선했을 때의 장점과 Before/After를 보여줍니다.
   - 빠른 작업은 빠르게 유지하고, 위험 작업은 승인/rollback/trace로 막습니다.

`generate-image-set.mjs`는 같은 내용의 SVG 원본을 재생성합니다. 이 디렉터리의 PNG 파일은 렌더링된 배포용 이미지이며, 스크립트만으로 PNG를 다시 쓰지는 않습니다.
