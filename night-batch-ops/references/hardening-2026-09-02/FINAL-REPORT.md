# 9점대 하네스 hardening + 자율 마무리 + 현황판 재설계 — 최종 보고 (2026-09-03 확정)

> 지휘 = Fable · 실행 = opus 워커 20개 · 적대 리뷰 = Codex(gpt-5.6-sol · read-only) **8회**. 커밋·푸시·운영 엔진 교체·jng-os 커밋은 **하지 않았다**(👤 승인 대기).
> 증거 폴더 `night-batch-ops/references/hardening-2026-09-02/`: codex-review-r1~r8 · TEST-RUN-FINAL(R4~R8 추기) · cli-verification · bench-stub · autofinish-jngos-report · INSTALL-ISOLATION · BRIEF · 설계서 3종 · dashboard-mockup.html.

## 0. 한 줄 결론
**Codex 8차 최종: must-fix High 0 · Medium 0 · Low 0 · 전체 테스트 813/813 GREEN · 저장소 commit-ready.** 운영 엔진 설치는 `INSTALL-ISOLATION.md` 의 A(러너 클론에 push 불가 자격증명) + D(GitHub 보호 브랜치) 적용 증거 확보 후 **조건부 ready**.

## 1. 1차 리뷰 13개 finding → 수정 파일과 테스트 (최종 판정)
| # | 심각도 | 수정 | 테스트(실제 동작) | 판정 |
|---|---|---|---|---|
| 1 추적 `.env`·키 diff 전송 | 높음 | `prepareReviewDiff` pathspec 제외 + `stripSensitiveFileSections` + 최종 `redactSecrets`(공용 `providers/redact.mjs`) | engine-e2e #1·#2 | FIXED |
| 2 슬롯 TOCTOU | 높음 | 고정 `codex-slot-N.lock` `wx` 원자 선점 + 심박 자식 + stale=max(3h,timeout×1.5) | providers-hardening #3(실 자식 4개) | FIXED |
| 3 워커 push 미감지 | 높음 | `git-guard.mjs` PATH shim(cmd/sh) · fail-closed · 자격증명·helper·askpass·SSH agent 제거 · `GIT_ALLOW_PROTOCOL=none` · 원격 URL 토큰 시작 전 거부 · 원격 ref/reflog 사후 비교 | engine-e2e #4·#5·N2 · providers-hardening git-guard/H3 | FIXED(코드) · **OS 샌드박스 잔여 → INSTALL-ISOLATION A+D 전제** |
| 4 `--commit` main 커밋 | 높음 | `commitPlaceOk` detached/`auto/*` 만 · 시작·커밋 시점 2중 | engine-e2e #6 | FIXED |
| 5 `pushOnFail` 우회 | 높음 | 폐지 · RED=rollback(reset 실측)·STOP·push 0 · 순차 경로 `--defer-push`+러너 1회 push | e2e-parallel #7·N1(bare origin 불변) | FIXED |
| 6 셸 주입 | 높음 | `spawn-safe.mjs` argv 분리 · `.cmd` 절대경로화 · 메타문자 거부 · 운영 소스 `shell:true` 0 · 알림 fetch | providers-hardening #8·#9 · engine-e2e M5 | FIXED |
| 7 Codex-only 프로브 | 중간 | `storyNeedsClaude` | engine-e2e #10 | FIXED |
| 8 미추적 테스트 무결성 | 중간 | 미추적 diff 포함 · `rule|file|지문` · integrity 기본 on | engine-e2e #11 · quality-rules | FIXED |
| 9 실패 증거 | 중간 | `archiveEvidence` code.diff·untracked·RESTORE.md(민감 제외·마스킹) | e2e-parallel #13 | FIXED |
| 10 조건부 게이트 미실행 | 중간 | 실제 `npm run` argv 실행 · RED 전파 | engine-e2e #14 | FIXED |
| 11 `.env` 격리 fail-open | 중간 | 전 민감 파일 격리 · 깊이 무제한 · readdir 실패 fail-closed · 복원 실패 exit 6 | providers-hardening #12 · engine-e2e N4/N5 | FIXED |
| 12 미열람 clean | 낮음 | 스토리+diff+구현 파일 열람 필수 · C-인용 경로 복원 | providers-hardening #15 · engine-e2e M6 | FIXED |
| 13 인박스 부재 | 낮음 | 트랜잭션형(인박스 먼저 rename) | engine-e2e #16·N8 | FIXED |

이후 라운드 신규 finding 누적: 2차 9 · 3차 10 · 4차 7 · 5차 2 · 6차 3 · 7차 2 → **전부 FIXED**(R2~R8). BRIEF 정책 16: **IMPLEMENTED 15 · PARTIAL 1**(정책 5 = OS 격리 부재 · 운영 격리로 보완).

## 2. 누락 테스트 10종 + 요구 시나리오 20종
1차 지적 10종·요구 시나리오 1~20 전부 실제 동작 테스트(실 git 저장소 · bare origin · 실 자식 프로세스 · 실 junction · 실 `.cmd` 심)로 추가. 매핑은 워커 보고(P·R·F1·E·F2·D·H1·H2·R3~R8)에 번호로 기재. 총 테스트 **202 → 813**(33파일 · 종단 4종). 각 수리는 **뮤테이션 확인**(되돌리면 RED) 동반.

## 3. 전체 테스트
```
node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')
tests 813 · pass 813 · fail 0 · skipped 0 · todo 0 · 581.9초 (R8 · Node v24.18.0 · Windows 11)
```
이력: 202(기준선) → 418 → 655 → 702 → 774(R4) → 793(R5) → 800(R6) → 811(R7) → **813(R8)**. 기본 동시성은 Windows 프로세스 고갈(0xC0000142)로 간헐 실패 → README 에 동시성 2 고정.

## 4. 실제 Claude/Codex 검증
- `claude --version` 2.1.250 · `codex --version` 0.152.1 · `codex login status` Logged in(ChatGPT).
- 실제 Codex read-only 교차 리뷰 **8회 완주**(15~22KB 보고서 · 회차별 finding → 수리 → 재판정).
- 실제 `claude -p` 스토리 완주 · 실 Fable 계획 호출 · 실 LLM 벤치 = **NOT VERIFIED**(BRIEF 금지 · 밤 배치 한도 보호). 전부 실제 node 프로세스 스텁.

## 5. Fable 오케스트레이션과 DAG
`plan-dag.mjs`(간선 3종 · 위상 · validator 12종) · `orchestrate.mjs`(Fable 계획 스키마 · 부분집합 검증 · 고정 오류 코드 폴백 · deadline 전달) · `assign.mjs`(난이도·위험·역할·가용성·연속 실패 · 홀짝 폐지) · `conflicts.mjs`(migration/schema/API/shared/test-env) · `metrics.mjs`(7지표) · `autofinish.mjs` 루프. 오케스트레이터 기본 **꺼짐**(실 계획 품질 미측정).

## 6. Quality / Integration Gate
품질 루프 integrity 기본 on · 수리 3/5 · 조건부 보안·성능 실제 실행 · 완료 기준 T1~T8(3유형 테스트 · 교차 provider 필수 · not-verified 전파). 통합 RED = rollback 실측·STOP·push 0 · 순차도 러너 1회 push · 매니페스트 pass/fail/rollback(sidecar).

## 7. Claude-only baseline 대비 (스텁 실측 · bench-stub.md)
두 팔 품질 게이트 통과 → 비교 유효. 모델 호출 4↔4 · 수리 0↔0 · 프로바이더 전환 0↔1. 시간·병렬 효율은 **스텁이라 의미 없음** — 실 LLM 수치 NOT VERIFIED(실측 경로: 실제 야간 2회 → `metrics-history.jsonl` `compareRuns`).

## 8. 자율 마무리 (SPEC §1~§10 · Codex 5차/8차)
IMPLEMENTED §1·2·3·4·6·7·9·10 · PARTIAL §5(예산 hard stop 은 best-effort — Job Object 부재 잔여) · §8(OS 격리 잔여). 안전 규칙 확정: 큐 `push` 리터럴 false(설정 true 거부) · 진단 전용 게이트 거부 · state/out 저장소 밖 강제 · Fable 오류 고정 코드+로그 마스킹 · 최종 재진단 항상 · 절대 deadline + 프로세스 트리 종료(taskkill /T + 고아 재귀 스윕) · BMAD 폐기 시 봉쇄. jng-os 읽기 전용 실측: 84 스토리 · 선언 done 19 · 검증 done 0 · **not-ready** · 쓰기 0 · 시크릿 0.

## 9. 현황판·아침 브리핑 (👤 승인 목업 v3 그대로)
정본 `dev-status/` 4모듈+플러그인 훅(110/110) · jng-os `tools/dev-status/` 이식(111/111 · 기존 블록 무삭제 · 3열 · 판정 티커) · `serve.mjs` 핫리로드 수정 · `.bat` 무변경 · GREEN 적극 조건만 · 진단 없으면 AMBER 상한 · scan 손상 내성 · morning-brief SKILL.md 개정.

## 10. 미구현 / NOT VERIFIED / accepted residual
- **OS 샌드박스 부재**(워커 절대경로 git·env 복구) — 코드 완화 + **INSTALL-ISOLATION A+D 운영 전제**.
- Job Object 부재(프로세스 트리 사후 스윕 · PID 재사용 창 · PowerShell 차단 시 스윕 실패 · 토큰 폴백 무력).
- BMAD 경로 검사 TOCTOU(응용 레벨 완화).
- 실 LLM 실행 전부(스토리 완주·Fable 계획·벤치·Codex dev 역할).
- POSIX 경로(npm argv · 프로세스 그룹 kill) — 계획 검증만.
- 프록시 환경 `HTTP(S)_PROXY` 제거 영향 · `install.mjs --register-tasks` · jng-os 실제 BMAD 쓰기 — 미실측.
- 5180 옛 현황판 서버는 사람이 닫아야 새 블록이 뜬다(프로세스 종료 권한 차단).

## 11. 5개 평가 기준 점수 (10점)
| 기준 | 점수 | 근거 |
|---|---|---|
| ① 안전성(비밀·push·격리) | **9** | 정책 16 중 15 IMPLEMENTED · must-fix 0 · 잔여 = OS 격리(운영 전제로 보완) |
| ② 정확성·완결성(finding 해소) | **9.5** | 1~8차 finding 전건 FIXED · 뮤테이션 전건 RED 확인 |
| ③ 테스트 실증 | **9** | 813 실동작 테스트 · 종단 4종 · anchor-only 격상 · 실 LLM 경로만 스텁 |
| ④ 자율 마무리 스펙 준수 | **8.5** | §10 중 8 IMPLEMENTED · 2 PARTIAL(best-effort deadline · OS 격리) · jng-os 실측 not-ready 판정 정직 |
| ⑤ 속도·병렬 효과 측정 | **7** | 지표 7종·비교기 구현 · 실 LLM 수치 없음(스텁만) |
| **종합** | **8.6 → 9점대 진입 조건 = A+D 적용 + 첫 야간 실 LLM 실측** | |

## 12. 커밋·엔진 교체 추천
1. **claude-skills 커밋·푸시 = 추천(가능)**: Codex 8차 commit-ready · 813/813. 문서·테스트·증거 포함 1커밋(또는 hardening / autofinish / dashboard 3커밋).
2. **jng-os `tools/dev-status`+morning-brief 커밋 = 추천(가능)**: 코드 변경이므로 승인 후 커밋(현황판은 읽기 전용 도구 · 밤 배치 무영향).
3. **전역 엔진 교체(`~/.claude/skills/*` · jng-os `tools/auto` 이식판 전환) = 조건부**: ① INSTALL-ISOLATION A+D 적용 ② 러너 유휴(lock 없음) 시점 ③ 첫 야간은 `providers.codex.roles=["review"]` · 오케스트레이터 꺼짐 · autofinish 는 `--diagnose-only` 로 시작.
