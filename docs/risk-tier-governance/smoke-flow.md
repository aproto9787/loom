# Governance Event Smoke Path

This smoke path exercises the implemented server event contract without performing any real side effect.

Start the server from this worktree, then register a local run:

```bash
curl -s -X POST http://127.0.0.1:8787/runs/register \
  -H 'content-type: application/json' \
  -d '{
    "runId": "governance-smoke",
    "flowPath": "examples/leader-workers.yaml",
    "flowName": "Leader-Workers",
    "agentType": "codex",
    "startTime": "2026-05-11T00:00:00.000Z",
    "source": "cli",
    "userPrompt": "Prepare a guarded setting change."
  }'
```

Classify the run as a guarded side effect:

```bash
curl -s -X POST http://127.0.0.1:8787/runs/governance-smoke/events \
  -H 'content-type: application/json' \
  -d '{
    "events": [{
      "ts": 1778467200001,
      "type": "manifest_update",
      "agentName": "leader",
      "summary": "classified as side effect",
      "raw": {
        "request": "Prepare a guarded setting change.",
        "interpretedGoal": "Prepare the change without executing it.",
        "riskTier": "side_effect",
        "governancePack": "side-effect-guarded",
        "workers": ["leader", "codex-reviewer"],
        "result": "running",
        "summary": "Approval and rollback are required before execution."
      }
    }]
  }'
```

This side-effect gate pass is expected to fail before evidence exists:

```bash
curl -s -X POST http://127.0.0.1:8787/runs/governance-smoke/events \
  -H 'content-type: application/json' \
  -d '{
    "events": [{
      "ts": 1778467200002,
      "type": "gate_record",
      "agentName": "leader",
      "raw": {
        "gate": "side-effect-boundary",
        "status": "pass",
        "reason": "Ready to execute."
      }
    }]
  }'
```

Record approval and rollback evidence, then pass the gate:

```bash
curl -s -X POST http://127.0.0.1:8787/runs/governance-smoke/events \
  -H 'content-type: application/json' \
  -d '{
    "events": [
      {
        "ts": 1778467200003,
        "type": "approval_recorded",
        "agentName": "leader",
        "raw": {
          "id": "approval-1",
          "gate": "side-effect-boundary",
          "status": "approved",
          "target": "guarded setting",
          "approver": "user",
          "approvalText": "Approved for smoke verification only."
        }
      },
      {
        "ts": 1778467200004,
        "type": "rollback_recorded",
        "agentName": "leader",
        "raw": {
          "id": "rollback-1",
          "gate": "side-effect-boundary",
          "status": "planned",
          "target": "guarded setting",
          "rollbackPlan": "Restore the previous value.",
          "currentState": "No live change has been made."
        }
      },
      {
        "ts": 1778467200005,
        "type": "gate_record",
        "agentName": "leader",
        "raw": {
          "gate": "side-effect-boundary",
          "status": "pass",
          "reason": "Approval and rollback evidence exist.",
          "evidence": ["approval-1", "rollback-1"]
        }
      }
    ]
  }'
```

Read the reconstructed manifest:

```bash
curl -s http://127.0.0.1:8787/runs/governance-smoke/manifest
```

Studio shows the same run state in the run detail governance panel.
