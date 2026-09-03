# 하네스 벤치 (스텁 실측) — 2026-09-02

> **절대 시간은 의미가 없다.** claude·codex 는 스텁 프로세스라 「생각하는 시간」이 0 이다.
> 이 표에서 뜻이 있는 것은 **재시도 수 · 모델 호출 수 · 병렬 효율 · 워커 유휴 비율 ·
> 품질 게이트 통과 여부**뿐이다. 벽시계·p50/p95 는 하네스 자체의 오버헤드(워크트리 생성 ·
> landing · 통합 게이트) 를 보여 줄 뿐 LLM 작업 시간을 대표하지 않는다.
>
> **실제 LLM 실측 = NOT VERIFIED** — 이 파일은 실 모델을 한 번도 부르지 않았다.
> 실측하려면 같은 스토리 세트를 실제 야간 배치로 두 번 돌리고 `metrics-history.jsonl` 의
> 두 줄을 `metrics.compareRuns` 로 비교한다(품질 게이트를 통과한 실행끼리만).

재현: `node night-batch-ops/engine/bench.mjs --stub`

- 스토리 세트: 2-1-a, 2-2-b (동일)
- 기준선 exit=0 · 새 하네스 exit=0

## 비교

**판정**: 비교 유효 — 두 실행 모두 품질 게이트 통과 — 비교 유효

| 지표 | 기준선(Claude-only) | 새 하네스 | 차이 |
| --- | --- | --- | --- |
| 전체(벽시계) | 10.294s | 6.423s | 3.871s 개선 |
| 직렬 합 | 5.399s | 3.547s | 1.852s 개선 |
| 병렬 효율 | 52.5% | 27.6% | 24.8% 악화 |
| 워커 유휴 비율 | 47.6% | 35.3% | 12.2% 개선 |
| 스토리 p50 | 2.508s | 4.041s | 1.533s 악화 |
| 스토리 p95 | 2.891s | 4.265s | 1.374s 악화 |
| 모델 호출 수 | 4 | 4 | 0 |
| 수리 라운드 | 0 | 0 | 0 |
| 프로바이더 전환 | 0 | 1 | 1 |

## 기준선(Claude-only · parallel 1)

| 항목 | 값 |
| --- | --- |
| 전체(벽시계) | 10.294s |
| 워커 | 1 |
| 직렬 합 | 5.399s |
| 병렬 효율 | 52.5% |
| 워커 유휴 | 4.895s (47.6%) |
| 스토리 p50 / p95 | 2.508s / 2.891s |
| 재시도 | 수리 0회 · 프로바이더 전환 0회 |
| 모델 호출 | claude/fable×2 · claude/opus×2 |
| 품질 게이트 | PASS — qa GREEN · 리뷰 high 0 · 통합 pass |

## 새 하네스(parallel 2 · Codex 리뷰 · 확장 충돌 · assign)

| 항목 | 값 |
| --- | --- |
| 전체(벽시계) | 6.423s |
| 워커 | 2 |
| 직렬 합 | 3.547s |
| 병렬 효율 | 27.6% |
| 워커 유휴 | 4.54s (35.3%) |
| 스토리 p50 / p95 | 4.041s / 4.265s |
| 재시도 | 수리 0회 · 프로바이더 전환 1회 |
| 모델 호출 | claude/fable×2 · claude/opus×1 · codex/codex:default×1(1500tok) |
| 품질 게이트 | PASS — qa GREEN · 리뷰 high 0 · 통합 pass |

## 원자료

```json
{
  "baseline": {
    "batchId": "2026-09-03-1788395285469",
    "label": "라운드 1",
    "branch": "auto/2026-09-03",
    "planSource": "deterministic",
    "schema": "night-batch-ops/metrics/1",
    "workers": 1,
    "wallMs": 10294,
    "serialMs": 5399,
    "occupancyMs": 5399,
    "idleMs": 4895,
    "idleRatio": 0.4755,
    "parallelEfficiency": 0.5245,
    "stories": [
      {
        "story": "2-1-a",
        "ms": 2508,
        "stages": 3,
        "exit": 0
      },
      {
        "story": "2-2-b",
        "ms": 2891,
        "stages": 3,
        "exit": 0
      }
    ],
    "p50Ms": 2508,
    "p95Ms": 2891,
    "retries": {
      "repairRounds": 0,
      "providerSwitches": 0
    },
    "modelCalls": [
      {
        "provider": "claude",
        "model": "fable",
        "calls": 2,
        "tokens": 0
      },
      {
        "provider": "claude",
        "model": "opus",
        "calls": 2,
        "tokens": 0
      }
    ],
    "tokens": 0,
    "qualityGate": {
      "passed": true,
      "why": "qa GREEN · 리뷰 high 0 · 통합 pass"
    }
  },
  "candidate": {
    "batchId": "2026-09-03-1788395294471",
    "label": "라운드 1",
    "branch": "auto/2026-09-03",
    "planSource": "deterministic",
    "schema": "night-batch-ops/metrics/1",
    "workers": 2,
    "wallMs": 6423,
    "serialMs": 3547,
    "occupancyMs": 8306,
    "idleMs": 4540,
    "idleRatio": 0.3534,
    "parallelEfficiency": 0.2761,
    "stories": [
      {
        "story": "2-1-a",
        "ms": 4265,
        "stages": 3,
        "exit": 0
      },
      {
        "story": "2-2-b",
        "ms": 4041,
        "stages": 3,
        "exit": 0
      }
    ],
    "p50Ms": 4041,
    "p95Ms": 4265,
    "retries": {
      "repairRounds": 0,
      "providerSwitches": 1
    },
    "modelCalls": [
      {
        "provider": "claude",
        "model": "fable",
        "calls": 2,
        "tokens": 0
      },
      {
        "provider": "claude",
        "model": "opus",
        "calls": 1,
        "tokens": 0
      },
      {
        "provider": "codex",
        "model": "codex:default",
        "calls": 1,
        "tokens": 1500
      }
    ],
    "tokens": 1500,
    "qualityGate": {
      "passed": true,
      "why": "qa GREEN · 리뷰 high 0 · 통합 pass"
    }
  },
  "comparison": {
    "comparable": true,
    "why": "두 실행 모두 품질 게이트 통과 — 비교 유효",
    "rows": [
      {
        "key": "wallMs",
        "label": "전체(벽시계)",
        "baseline": "10.294s",
        "candidate": "6.423s",
        "delta": "3.871s",
        "direction": "개선"
      },
      {
        "key": "serialMs",
        "label": "직렬 합",
        "baseline": "5.399s",
        "candidate": "3.547s",
        "delta": "1.852s",
        "direction": "개선"
      },
      {
        "key": "parallelEfficiency",
        "label": "병렬 효율",
        "baseline": "52.5%",
        "candidate": "27.6%",
        "delta": "24.8%",
        "direction": "악화"
      },
      {
        "key": "idleRatio",
        "label": "워커 유휴 비율",
        "baseline": "47.6%",
        "candidate": "35.3%",
        "delta": "12.2%",
        "direction": "개선"
      },
      {
        "key": "p50Ms",
        "label": "스토리 p50",
        "baseline": "2.508s",
        "candidate": "4.041s",
        "delta": "1.533s",
        "direction": "악화"
      },
      {
        "key": "p95Ms",
        "label": "스토리 p95",
        "baseline": "2.891s",
        "candidate": "4.265s",
        "delta": "1.374s",
        "direction": "악화"
      }
    ],
    "calls": {
      "baseline": 4,
      "candidate": 4
    },
    "retries": {
      "baseline": {
        "repairRounds": 0,
        "providerSwitches": 0
      },
      "candidate": {
        "repairRounds": 0,
        "providerSwitches": 1
      }
    }
  }
}
```
