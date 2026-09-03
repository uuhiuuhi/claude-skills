# 현황판·아침 브리핑 재설계 — 새 배치 하네스 대응 (2026-09-02 · 설계 워커 산출 · 지휘 저장)

👤 요구(2026-09-02): 아침에 브리핑과 현황판을 보면 **전체 진행 · 진행 예정 · 병렬 작업 · 사용 LLM(프로바이더·모델)** 등 개선된 배치에 맞는 정보가 보여야 한다. 읽는 사람은 비개발자(박사장)다.

불변 원칙: 외부 의존성 0 · Node 단독 · **LLM 호출 0**(판정은 전부 규칙) · 읽기 전용 · 새로고침마다 재생성.

---

## 1. 현행 보존 목록 — 없애면 손해인 것

### 1.1 정보 구조(jng-os 고유판 `tools/dev-status/build.mjs` 실측)
| 블록 | 내용 | 원천 |
|---|---|---|
| 헤더 | brand + 생성 시각 + 상태 파일 시각 + live 점 | `generatedAt` · `sprintUpdated` |
| 티커 | 에픽수 · 스토리수 · 목업(채택) · 불일치 · 다음작업 · 사람대기 · 미적용 마이그레이션 | 집계 |
| 러너 실황 | lock·심박·배치 라벨·병렬 폭·스토리별 stage/model·오늘 누계·큐 크기·마지막 완주 | `~/.baroos-auto/slots.log` |
| ① 다음 진행할 작업 | 상태값 순(review→in-progress→ready→backlog) + 묶음 실행 추천 | `sprint-status.yaml` + File List |
| ② 마무리 안 된 사람 대기 | 파일럿 게이트 · deferred-work · 목업 pending · 마이그레이션 · queue.json | 6개 원장 |
| 커버리지 줄 | 「못 센 것을 못 셌다」 공시 | parseDeferred |
| ③ 불일치 | 4종 드리프트 | epics.md ↔ sprint-status.yaml |
| 전체 진행률 | 대형 % + 상태 막대 + 범례 | sprint |
| 스토리 표 | 에픽별 · 필터/검색 · 단계 배지 4칸 | `state.json` |
| 목업 확인 | 썸네일 그리드 + 판정 | `mockup-verdicts.json` |
| 참고 접기 | 잔여로 세지 않은 것 공시 | parseDeferred |
| 앱 미리보기 탭 | 5173 dev/preview 실행 | serve.mjs |
| footer | 원천 파일 전량 공시 + 「직접 고치지 마세요」 | 고정 |

### 1.2 반드시 살려야 할 판정 규칙
1. **RC1(deferred-work 분류)** — 줄 표지로 가른다. 해소(`~~취소선~~`·`✅ 해소`) 제외 / 기록(`→ 반영`·`→ 처리`·`Patch → 반영 N/N`) 제외 / 잔여 표지(`[신규 Defer]`·`[재확인 · 미조치]`·`[👤]`·`[Decision]`) / 표지 없으면 보수 기본값 = 「막는 것」. 한글 어휘 주변 `\b` 금지.
2. **RC7(성격 칩)** — 실행 미완/확인·결정 대기/알려진 제약/심각도 밖 4칸. 0인 칩은 안 그린다.
3. **커버리지 정직성** — 못 센 것을 화면에 건수로 적는다. 「전량」이라고 쓰지 않는다.
4. **원장이 있는 것을 옮겨 적지 않는다** — 손으로 적는 파일은 `queue.json`·`mockup-verdicts.json` 둘뿐.
5. **File List 겹침 그리디 색칠** — `_bmad-output/**` 제외 · File List 없으면 단독 순차 · 배치 가동 중 버튼 비활성.
6. **리뷰 게이트 6회**(이식판) — 완료된 리뷰(`exit=0`)만 센다.
7. **원칙 ⑦ 「추천으로 끝난다」** — 화면 마지막은 언제나 다음 작업 추천.
8. **콘솔은 실행하지 않는다** — 「대화창에 낼 명령」까지만 준비.

### 1.3 고유판 vs 이식판 차이
| 항목 | jng-os 고유판 | 이식판 `claude-skills/dev-status/` | 새 설계 |
|---|---|---|---|
| 루트 탐지 | 고정 | `--root` → 상위 6단 → BMad config | 이식판 채택 |
| 상태 폴더 | `~/.baroos-auto/` 하드코딩 | 없음 | `AUTO_BATCH_STATE_DIR` → cfg.stateDir → `~/.claude-auto/<project>` 통일 |
| 엔진 경로 불일치 배너 | 없음 | 있음 | 이식판 채택 |
| 파일럿 게이트 · deferred RC1 · 목업 판정 · 마이그레이션 프로브 | 있음 | 없음 | **프로젝트 플러그인** |
| 손 대기열 `queue.json` | 있음 | 없음 | 공용(선택) |
| 러너 실황 | slots.log | run-summary 헤더만 | 공용화(폴백) |
| 리뷰 6회 게이트 | 없음 | 있음 | 공용화(설정) |
| 앱 실행기 | 있음 | 없음 | 고유 유지 |
| 새 하네스 블록 | 없음 | 없음 | **양쪽 공용 신규** |

---

## 2. 새 화면 정보 구조 (위 → 아래)
우선순위: **오늘 사람이 무엇을 해야 하는가 → 밤에 무엇이 됐나 → 오늘 무엇이 도나 → 얼마나 잘 도나 → 세부**.

> **👤 2026-09-03 지시 — 기존 기능 전부 보존(삭제 금지)**: 새 블록은 **추가**일 뿐이다. 다음은 현행 그대로 유지한다.
> ① **탭 2개**(「개발 진척」 / 「앱 미리보기」 — serve.mjs 5173 dev/배포본 실행·정리하고 시작·새 탭 열기) ② **에픽별 스토리 진행 표**(에픽 접기/펼치기 · 상태 칩 · 단계 배지 4칸 · 검색/필터 · 각 스토리 행에 **「스토리 문서」·「목업 보기」 링크**) ③ **목업 확인 갤러리**(채택/확인 대기/미채택 3그룹 · 썸네일 iframe · 클릭 시 원본 새 탭 · `mockup-verdicts.json` 판정) ④ 티커(목업 수·채택 수 포함) ⑤ 다음 할 일 · 사람 대기 · 불일치 · 커버리지 공시 · 참고 접기 · footer 원천 공시.
> 새 블록 ④~⑦ 은 이 사이에 끼워 넣고, 스토리 표에는 **워커·라운드·마지막 리뷰어 열을 추가**만 한다. 목업(`dashboard-mockup.html`)도 이 보존 항목을 실제로 그린다.

### ① 헤더 — 날짜 · 슬롯 심박 · 배포 가능 판정
- 심박: `slots.log` mtime — `lock + <45분` 가동 중(초록) / `lock + ≥45분` **심박 없음 1급 경보** / `lock 없음 + 지난밤 0건` **밤이 안 돌았다 1급 경보** / 파일 없음 「러너 로그 없음」 회색.
- 판정 배지(빨강 신설 금지): RED = 주황 채움 / AMBER = 주황 테두리 / GREEN = 그린 테두리 / 판정 불가 = 회색.

| 판정 | 조건(하나라도) |
|---|---|
| RED | 배치 매니페스트 `integration.result ∈ {fail, rollback}` · `worst ≥ 7` · 자율 진단 우선순위 ①②③ 잔여 > 0 |
| AMBER | `metrics.qualityGate.passed=false` · `queue.validation.ok=false` · 검증 매니페스트 `checks` 에 fail/required-missing · 결정 대기 > 0 · 미머지 `auto/*` ≥ 1일 · 진단 ④⑤ 잔여 > 0 |
| GREEN | 위 전부 아님 **그리고 적극 조건 전부 충족**(Codex 3차 H2 반영 · 2026-09-03): 지난밤 배치 ≥ 1 이고 전 배치 `integration.result==='pass'` · `metrics` ≥ 1 이고 전부 `qualityGate.passed===true` · 지난밤 배치가 돌린 **스토리마다 검증 매니페스트 존재** + `checks` 실패 0 · **자율 진단 산출물 존재** · **readiness.verdict==='ready'**. 빈 배열은 「전부 통과」가 아니다 |
| 판정 불가 | 재료 없음 — **GREEN 이 아니다** · 진단 산출물 없음 → `if (!diagnosis)` 단독 조건으로 **상한 AMBER** |
배지 옆 이유 문장 1줄 항상.

### ② 결정 인박스
원천 `DECISIONS-INBOX.md`(미머지 체인 있으면 `git show origin/auto/<최신>:<경로>`). `## 🟠 결정 대기` = 대기 · `### 🟢 함께 봐 주실 것` = 사후 확인 · `## ✅ 확정` 제외. `등재 YYYY-MM-DD` 로 대기 일수 · **3일 이상 맨 위 + 주황**. 없으면 「결정 대기 0건」, 파일 없으면 「인박스 미사용」 회색.

### ③ 전체 진행
에픽별 진행률(현행) + 고유 스토리 전진 · done 증가(`metrics-history.jsonl` 날짜별 고유 키 · 없으면 archive 날짜 + night-last-run 「완주」 줄로 근사 — 「추정」 표기) · high/medium(`<story>-verification.json.review`) · 7일 스파크라인(inline SVG · 점 2개 미만이면 생략).

### ④ 지난밤 배치(카드)
원천 `batch-<id>-manifest.json`(schema `night-batch-ops/batch-manifest/1`: batchId·label·branch·at·stories·stages·workers·landing[]·failed[]·integration{result,qaExit,landingBase,at}·pushed·worst). 카드 항목: 스토리 칩 · 단계 배지 · **워커 = 프로바이더/모델**(정본 `<story>-verification.json.workers` → 폴백 `run-summary.log` `[ASSIGN]` → `metrics.modelCalls` → `—`) · 병렬 여부/워크트리(`workers≥2 && landing≥2`) · 통합 게이트(pass 그린 / fail·rollback 주황 채움 / 미실행 회색 · rollback 이면 되돌린 건수+`landingBase`+archive 태그) · 재시도·전환(`metrics.retries`) · 시간(wallMs·p50·p95) · 증거 링크(`failed[].evidence` 폴더 실존 시만 `file://`). 없으면 `night-last-run.md` 「완주」 줄 폴백.

### ⑤ 오늘 예정 큐
원천 최신 `auto-queue-*.json` 또는 `night-queue.json`. **plan.source**(`deterministic`/`fable`/`deterministic-fallback(…)` · 폴백은 주황) · **validation 경고**(`errors[{code,key,msg}]` + `_편성.excluded`) · 배치 순서 · 병렬 짝 칩 · **배정 이유 why**(`_편성.picked` + `[ASSIGN]` 난이도·위험) · **사용 LLM**(`batches[].models` · `codex:` 칩 · `assign-history` failStreak≥2 「회피 중」). 없으면 「18:00 편성 전」.

### ⑥ 계측(지난 3일 · 하루 단위 — 👤 2026-09-03 지시)
원천 `metrics-history.jsonl`(줄마다 `at`·`batchId`) + 오늘 `metrics-<id>.json`. **하루 = 그날 밤 배치 묶음**(18:00 ~ 다음날 아침 · `at` 의 날짜를 18:00 기준으로 접어서 「지난 1일 / 2일 / 3일」로 배정). 표 형태: **행 = 지표 6개 + 모델 호출량, 열 = 지난 1일 · 2일 · 3일 · 추세**. 지표 6개(7일판과 동일): 순차 대비 절약(Σ serialMs − Σ wallMs) · 병렬 효율(Σ serialMs / (workers × Σ wallMs)) · 유휴(Σ idleMs / Σ capacityMs) · 첫 시도 통과율(근사 명시) · 리뷰 결함 high(medium 괄호) · 통합 실패율(그날 배치 중 rollback/fail 비율 · 분모 함께). 추세 = 3일 방향(개선/악화/평평 · 값 2개 미만이면 「—」). 배치 0건인 날은 전 칸 `—` 와 「배치 없음」. 헤더에 각 날의 배치 수를 병기. 품질 게이트 미통과 실행은 집계에서 제외하고 「제외 N」 표기.

### ⑦ 자율 마무리 진단
원천 = AUTONOMOUS-FINISH-DESIGN §1-1 `Diagnosis`(`night-batch-ops/diagnosis/1`) + `Backlog`(`byTier`) + `Readiness`(`night-batch-ops/readiness/1` · verdict ready/not-ready/not-verified). 분류 5칸(verified-done/partial/missing/defect/test-gap) + 우선순위 7단계 막대 + 배포 차단 목록. **산출물 없으면 회색 + 헤더 판정 상한 AMBER**(미확인을 통과로 표시 금지).

#### ⑦-확정 산출 스키마 (워커 C 구현 · 2026-09-03 · **현황판은 이것을 읽는다**)

`<state>/autofinish/<runId>/` 아래에 라운드마다 `diagnosis.json`·`backlog.json`, 실행 끝에 `readiness.json`·`report.json`·`report.md`.

**`readiness.json` — `night-batch-ops/readiness/1`** (`engine/readiness.mjs` · `projectReadiness`/`taskReadiness` 가 같은 모양을 낸다)
```jsonc
{
  "schema": "night-batch-ops/readiness/1",
  "at": "2026-09-03T02:00:00.000Z",           // 진단 시각(없으면 null)
  "kind": "project",                           // "project" | "task"
  "subject": "C:/Projects/jng-os",             // task 면 스토리 키
  "title": "배포 가능 여부",
  "verdict": "not-ready",                      // ready | not-ready | not-verified — ⑦ 헤더 상한: not-verified 는 GREEN 금지
  "criteria": [                                // project = P1~P8 · task = T1~T8 (순서 고정)
    { "id": "P2", "label": "높음·중간 차단이 0이고 상위 3단계 지적이 없다",
      "required": true, "result": "fail",      // pass | fail | not-verified
      "why": "높음·중간 지적 281건 · 상위 3단계 1건",
      "evidence": [{ "file": "diagnosis.json", "field": "findings[].severity" }] }
  ],
  "counts":  { "pass": 0, "fail": 5, "notVerified": 3, "total": 8 },
  "blockers":    [{ "id": "P2", "label": "…", "why": "…" }],        // result=fail 만
  "notVerified": [{ "what": "…", "why": "…", "criterion": "P3" }],  // result=not-verified + 전파 사유
  "metrics": { "wallMs": 3600000, "qualityGate": { "passed": true, "why": "…" } }
}
```
전파 규칙(코드 강제 · `propagate()`): fail ≥1 → `not-ready` / fail 0 & not-verified ≥1 → `not-verified` / 전부 pass → `ready`.
추가로 **`diagnosis.notVerified` 가 비어 있지 않으면 `ready` 를 내지 않는다**(전부 pass 여도 `not-verified` 로 내려간다 — 「미확인을 통과로 표시 금지」). 현황판은 `verdict` 만 보고 색을 정하면 되고, 회색은 파일이 아예 없을 때만이다.

**`report.json` — `night-batch-ops/report/1`** (`engine/report.mjs` · `renderReportJson` · 모든 문자열은 재마스킹 후)
```jsonc
{
  "schema": "night-batch-ops/report/1",
  "at": "…",
  "run": { "id": "…", "project": "jng-os", "startedAt": "…", "endedAt": "…", "rounds": 2, "mode": "autofinish" },
  "verdict": "not-ready",                      // readiness.verdict 와 같은 값
  "headline": "❌ 아직 배포하면 안 됩니다 — 모자란 것: …",  // ⑦ 카드 한 줄로 그대로 쓸 수 있다
  "missing": ["아직 「실제로 된다」가 아닌 기능 70건", "…"],
  "counts": { "stories": 84, "verifiedDone": 0, "notVerified": 14, "open": 87 },
  "indicators": {                              // 설계 §8 지표 7종 · 값 없으면 null · approx=근사 표기 의무
    "time": { "wallMs": null, "p50Ms": null, "p95Ms": null, "stories": [] },
    "parallel": { "workers": null, "efficiency": null, "idleMs": null, "idleRatio": null },
    "firstPass": { "value": 0.5, "ok": 1, "total": 2, "approx": true },
    "review": { "high": 0, "patch": 0, "decision": 0, "defer": 0, "approx": true },
    "autoFix": { "repairRounds": 1, "providerSwitches": 0, "repeatedFailures": 1, "approx": true },
    "integration": { "pass": 2, "fail": 0, "unknown": 0, "runs": 2, "failRate": 0 },
    "saving": { "ms": 2400000, "approx": true }
  },
  "comparison": { "comparable": false, "why": "비교 불가 — 게이트 조건이 다릅니다…", "rows": [] },
  "readiness": { "verdict": "not-ready", "counts": {}, "blockers": [] },
  "tasks": [{ "subject": "2-1-…", "verdict": "not-ready", "counts": {} }],
  "sections": [{ "n": 1, "id": "capabilities", "title": "지금 이 프로젝트가 할 수 있는 것", "lines": ["…"] }],
  "notVerified": [{ "what": "…", "why": "…" }],
  "decisions": [{ "title": "…", "why": "…", "options": [], "recommended": "…", "safeDefault": "…" }]
}
```
`sections` 의 `n`·`id`·`title` 은 SPEC §10 순서로 **고정**(1 capabilities · 2 completed · 3 gates · 4 flows · 5 autofix · 6 time · 7 risks · 8 notVerified · 9 deployable · 10 decisions). 현황판이 일부만 써도 번호로 집으면 된다. `comparison.comparable=false` 면 수치를 나란히 그리지 말고 사유만 적는다(게이트 조건이 다른 두 실행은 비교하지 않는다).

**`<story>-verification.json` 안의 `completion` 블록 — `auto-story-finish/completion/1`** (`auto-story-finish/completion-rules.mjs` · 파이프라인 훅이 붙인다)
```jsonc
"completion": {
  "schema": "auto-story-finish/completion/1",
  "criteria": [{ "id": "T5", "label": "…", "result": "fail", "why": "검사를 끄거나 우회한 흔적 1건(test-skip)" }], // T1~T8 고정
  "verdict": "not-ready",
  "counts": { "pass": 6, "fail": 1, "notVerified": 1, "total": 8 },
  "notVerified": [{ "what": "…", "why": "…", "criterion": "T4" }],
  "evidence": {
    "newTests": { "files": ["tests/feature/c.test.ts"], "cases": 2 },
    "integrityBlocking": 1,
    "review": { "provider": "codex", "high": 0, "readEvidence": 3 },
    "state": { "statusInFile": "done", "statusInSprint": "done", "openPatch": 0, "openDecision": 0 }
  }
}
```
**블록이 없으면** = 파이프라인 훅 미배선이다. 그때 ⑧ 스토리 표의 완료 칸은 「확인 못 함」이고 GREEN 이 아니다(readiness 가 T2·T8 을 `not-verified` 로 낸다 — 기능 손실은 없다).

### ⑧ 스토리 표 (+3열: 워커 · 라운드 · 마지막 리뷰어 프로바이더 — 값이 하나라도 있을 때만 열 표시)
### ⑨ 불일치·경고 (기존 4종 + `unknown-story` · `integration=fail` · verification unknown 인데 완료로 보이는 스토리)
### ⑩ 다음 작업 추천 (후보 순서: 배포 차단 → 통합 되돌림 회수 → 결정 대기 → 미머지 머지 → 사람 게이트 → 목업·스펙 승인 → 상태값 순. 「더 하실 일 없음」 금지)

---

## 3. 데이터 소스 카탈로그
| # | 파일 | 위치 | 스키마 | 부재 시 |
|---|---|---|---|---|
| 1 | `epics.md` | planning-artifacts | — | exit 2 |
| 2 | `sprint-status.yaml` | implementation-artifacts | — | exit 2 |
| 3 | `state.json` | auto-pipeline-logs | — | 배지 회색 |
| 4 | `night-last-run.md` | auto-pipeline-logs | md | ④ 폴백 |
| 5 | `run-summary.log` | auto-pipeline-logs | 텍스트 | `[ASSIGN]` 생략 |
| 6 | `batch-<id>-manifest.json` | auto-pipeline-logs | batch-manifest/1 | 「매니페스트 없음」 |
| 7 | `<story>-verification.json` | auto-pipeline-logs | verification/1 | 워커 열 숨김 |
| 8 | `metrics-<id>.json` | auto-pipeline-logs | metrics/1 | ⑥ `—` |
| 9 | `metrics-history.jsonl` | stateDir | 줄 JSON | 스파크 생략 |
| 10 | `assign-history.json` | stateDir | `{version:1, entries{"story|provider|role":{attempts,fails,failStreak,rounds,avgRounds}}}` | 라운드 폴백 |
| 11 | `auto-queue-*.json` | stateDir | `{planned,updated,defaults,batches,validation,_편성}` | 「예정 큐 없음」 |
| 12 | `archive/*-evidence/<story>/` | stateDir | evidence/1 | 경로만 |
| 13 | `slots.log` · lock | `~/.baroos-auto/` 또는 stateDir | 텍스트 | 「로그 없음」 |
| 14 | `DECISIONS-INBOX.md` | implementation-artifacts | md | 「인박스 미사용」 |
| 15 | 자율 진단·백로그·readiness JSON | `<state>/autofinish/<runId>/` 또는 auto-pipeline-logs | diagnosis/1 · readiness/1 | ⑦ 회색 + AMBER 상한 |
**손상 내성**: JSON 실패 = 그 블록만 「읽지 못했습니다(파일·사유)」 · 나머지는 그대로. 예상 밖 schema = 「알 수 없는 형식」 + 원문 링크(추측 렌더 금지).

---

## 4. 하네스 쪽 보완 요청 (F2/D 워커)
1. 배치 매니페스트에 per-story 배정 `assign:[{story,dev,devProvider,review,reviewProvider,difficulty,risk,why}]` 추가(run-night 의 `wts` 에 재료 있음). 그 전까지 verification.json 정본.
2. `metrics.summarizeTimeline.stories[]` 에 `provider/model` 포함.
3. `run-night` 가 `quality={integration}` 만 넘겨 `highFindings` 항상 0 → 리뷰 결함 수 채우기.
4. 자율 진단 산출물 경로·스키마는 AUTONOMOUS-FINISH-DESIGN §1 확정본을 따른다.

---

## 5. 아침 브리핑 SKILL.md 개정안 (낭독 15~20분 · 절별 상한)
```
0. (신설) 30초 결론 — 3줄 고정: ① 배포 가능 판정 + 이유 ② 오늘 결정 N건(3일+ M건) ③ 오늘 밤 예정 N배치(병렬 M쌍). 재료 없으면 「판정 불가」.
1. 저장소 정렬(현행) — git fetch → 미머지 auto/* → git show origin/auto/<최신>:<경로>
2. 지난밤(≤6줄) — [의무] 슬롯 심박 0건 1급 경보 · [의무] 한도 대기 분 · [신설·의무] 통합 게이트 배치별 pass/fail/rollback(rollback 이면 건수+태그) · [신설] 워커=프로바이더/모델·병렬 폭·재시도/전환 · [신설] 증거 폴더 · exit 해석표(3 인증·5 한도·6 커밋 가드·4 dirty)
3. 오늘 예정(≤5줄 · 신설) — [의무] plan.source(폴백이면 사유) · [의무] validation 경고 · 배치 순서·병렬 짝·why·LLM
4. 계측 요약(≤3줄 · 신설) — 절약·병렬 효율·유휴·첫 시도 통과율 7일 추세
5. 자율 진단 요약(≤4줄 · 신설) — 5분류 건수 + 배포 차단 전건(생략 금지) · 없으면 「진단 미실행」
6. 현황판(현행) — 달라진 칸만
7. 결정 인박스(현행 · 핵심) — 3일+ 먼저 · 사후 확인 10건 초과 묶음
7-2. 결정 소진(현행 읽기 전용 예외)
8. 다음 작업 추천(후보 순서 = 2절 ⑩) — 「더 하실 일 없음」 완성일 단 한 번
```
압축: 각 절 「달라진 것」만 · 배치 3개 초과면 pass 아닌 것 + 병렬만 개별.

---

## 6. 구현 분할
**두 갈래는 합칠 수 있으나 이번 라운드엔 합치지 않는다** — 새 블록 ④⑤⑥⑦⑧은 프로젝트 무관이라 공용 모듈 1벌. 걸림돌은 jng-os 고유 6규칙(파일럿 게이트·RC1/RC7·목업·마이그레이션 프로브·앱 실행기·slots 경로·리뷰 임계) → 플러그인 계약(`plugins: [...]` · `{ waiting(): [] }`)·설정으로 빼는 것은 별건.

| 갈래 | 파일 | 작업 | 규모 |
|---|---|---|---|
| (a) 이식판 `claude-skills/dev-status/` **정본** | `batch-sources.mjs`(신규) | 새 산출물 파서 전량(매니페스트·검증·계측·이력·배정·큐·증거·인박스·진단) | ≈420 |
| | `verdict.mjs`(신규) | 배포 가능 판정 순수 함수 | ≈90 |
| | `scan.mjs` | 파서 호출 + stateDir 해석 | +60 |
| | `build.mjs` | 블록 ①②④⑤⑥⑦⑨ 렌더 + ⑧ 3열 | +380 |
| | `SKILL.md` | 갱신 | +60 |
| (b) jng-os `tools/dev-status/` | `batch-sources.mjs`·`verdict.mjs` | (a) 복사(`// SOURCE:` 헤더) | 동일 |
| | `scan.mjs`·`build.mjs` | 호출·렌더 이식 · 고유 블록 전부 유지 · 티커 「배포 판정」 1칸 | +430 |
| | `README.md` | 원천 표 +9종 | +25 |
| (c) `jng-os/.claude/skills/morning-brief/SKILL.md` | 5절 개정안 교체 | (a)(b) 이후 | +70 |
| (d) `.bat` | **변경 불필요**(serve.mjs·포트 그대로) | — | 0 |
순서: (a) 파서+판정+단위 테스트 → (a) 렌더+스냅숏 → (b) 이식+jng-os 실산출물 스모크 → (c) → 하네스 보완 4건 별도 요청.

---

## 7. 테스트 계획
- 7.1 파서 단위(`batch-sources.test.mjs`): 산출물마다 정상/부재/손상 3케이스(매니페스트 4종 · verification · metrics/history 깨진 줄만 버림 · assign-history · queue · evidence · 인박스 · 진단).
- 7.2 판정(`verdict.test.mjs`): RED 4경로 · AMBER 6경로 · GREEN 1 + **「재료 0 → 판정 불가(GREEN 아님)」** · RED+GREEN 동시 → RED.
- 7.3 렌더 스냅숏: 풍족/빈손/손상 3벌 — 핵심 문자열 존재/부재 단언(빈손은 예외 0 + 「없음」 8종 + 「GREEN」 부재).
- 7.4 실물 스모크(읽기 전용): jng-os 빌드 1회 · 예외 0 · 원천 mtime 불변 · 새 블록 전부 「없음」 + 기존 동일.

---

## 핵심 발견 3가지
1. 배치 매니페스트 `workers` 는 폭(숫자)뿐 — per-story LLM 정본은 `<story>-verification.json.workers`.
2. `run-night.mjs` 가 `quality={integration}` 만 넘겨 `highFindings` 항상 0 — ⑥-5 는 verification 집계로.
3. 자율 진단 산출물은 AUTONOMOUS-FINISH-DESIGN §1 스키마(diagnosis/1 · readiness/1) 확정 — 부재 시 헤더 상한 AMBER 가 핵심 안전장치.
