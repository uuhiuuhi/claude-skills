---
name: git-runner
description: 깃러너 — 배포·main 반영을 한 곳(예약 작업)에서만 하는 배포 줄. 작업 창·러너 지휘 창은 리뷰·done 뒤 「배포 요청서」(JSON) 한 장을 대기열에 넣고 끝내고, 예약 작업 BaroOS-gitrunner 가 1분마다 1건씩 최신 main 과 합치기 → 합친 판 검사 → main 푸시(먼저) → 운영 DB 덧셈만 자동 적용 → 화면 배포(Cloudflare Workers) → 실측(RED 면 되돌림) → RELEASE-LOG·태그까지 한다. 배포 안 하는 시간(기본 08:50~12:00·13:00~19:00)에는 사람이 직접 요청한 건만 처리하고 나머지는 「미리 검사」만 돌려 둔다. 덧셈 아닌 DB 변경·기존 마이그레이션 수정·유일 색인·새 Edge Function·외부 발송은 멈추고 사람에게 넘긴다(기존 Edge Function 코드 수정은 교차 검토 기록이 있으면 자동 배포 · 실패 시 직전 main 판으로 되돌림). "배포 요청 넣어줘", "깃러너 설치", "깃러너 상태", "배포 줄 어떻게 돼", "멈춘 배포 요청 봐줘"에 사용한다. 정본 = GitHub uuhiuuhi/claude-skills `git-runner/` (v0.1 · 2026-11-11).
---

# git-runner (v0.1 · 2026-11-11)

**한 줄**: 배포를 여러 창이 각자 하면 나중 판이 앞 판의 수정을 빠뜨린다(BaroOS 11-09 실사고). 그래서 **배포·main 반영은 깃러너 한 곳**만 하고, 다른 창은 **요청서만** 낸다.

## 구성 (scripts/)
| 파일 | 하는 일 |
|---|---|
| `gitrunner.sh` | 본체. 잠금(mkdir · 죽은 pid 넘겨받기) → 대기열 1건 → 합치기·판정·검사 → main 푸시 → 운영 DB 덧셈 → 빌드·배포 → 실측 → 기록. 연습 = `GR_DRY=1`(푸시·DB·배포 끔) |
| `gitrunner-lib.mjs` | 요청서 검사(`validate`) · 칸 읽기(`get`) · 교체되는 함수/뷰·유일 색인 찾기(`replaced`) · 운영 적용 묶음 만들기(`build-apply` = 한 트랜잭션 · 이미 적용 가드 · 장부 기록) · 결과 파일(`result`) |
| `run-gitrunner-hidden.ps1` | 예약 작업 실행기. 대기열이 비면 bash 도 띄우지 않고 끝 |
| `register-gitrunner-task.ps1` | 예약 작업 등록(1분 반복 · IgnoreNew) — **사람이 한 번 실행**(대화 창 자동 실행 모드는 지속 실행 등록을 막는다) |
| `references/REQUEST-FORM.md` | 요청서 양식·제출법·결과 위치 — 요청하는 창에 이 파일을 알려 준다 |

## 흐름
1. **대기열**: `~/.baroos-auto/gitrunner/queue/<YYYYMMDD-HHMM>-<주제>.json` (이름 순서대로). 필수 칸 = id·requester·branch(`auto/`)·commit(40자)·summary·checks·rollback · DB 파일이 있으면 compat(지금 운영 화면이 그대로 도는 이유)·access(누가 읽고 실행하나) 필수.
2. **배포 안 하는 시간**(매일 08:50~12:00 · 13:00~19:00): `"humanRequested": true`(사람이 직접 「배포해줘」 한 건 — 작업 창이 스스로 true 금지)만 처리. 나머지는 **미리 검사**(합치기·판정·검사만 · 운영 무변경) → 걸리면 `held/` 로 옮겨 요청 창이 고칠 시간을 주고, 통과하면 `precheck/<id>.ok`(main·커밋·합친 트리) 기록 → 시간이 끝난 뒤 main 이 그대로면 검사 없이 바로 반영.
3. **합치기**: 최신 `origin/main` 위에 요청 커밋(앞으로 감기 우선 · 아니면 merge). 상태표(`sprint-status.yaml`) 하나만 충돌이면 키 단위로 합침, 그 밖 충돌 = 멈춤.
4. **판정(멈춤)**: Edge Function 중 새 함수·새 비밀값 이름·공용 `_shared`·발송 담당 함수·교차 검토 기록(`crossReview`) 없음(기존 함수 코드 수정은 자동 — 👤 2026-11-12) · 이미 있던 마이그레이션 수정/삭제 · `tools/ops/additive-check.mjs` 가 덧셈 아님(판정 불가도 멈춤 = fail-closed) · 유일 색인.
5. **검사**: 타입 검사 · 바뀐 파일 eslint · 정적 시험(원장·마이그레이션 가드 + 바뀐 시험 · 실DB 시험 제외) — 요청 창이 전체 qa 를 했으므로 「합친 결과가 깨지지 않았나」만.
6. **main 푸시 먼저**(거절 = main 이 움직임 → 3회까지 다시 합침) → `ls-remote` 실측.
7. **운영 DB 덧셈**: 운영 장부에 없는 새 마이그레이션만 · 교체되는 함수/뷰의 지금 정의를 먼저 떠 둠 · 한 트랜잭션 적용 → 장부 재실측. 산출물 = `~/.baroos-auto/archive/release-<날짜>-gitrunner-<id>/`(apply-prod.sql · CHECKS.md · before-*.json).
8. **화면 배포**: `.env.production`·`public/manual`(gitignore 대상) 복사 → preflight(파이프 없이) → vite build → 번들 호스트 실측(운영 ref ≥1 · 개발 ref 0) → `wrangler deploy --env production`.
9. **실측**: 서빙 번들 = 빌드 번들 · 조각 200 · `/manual/` 크기 >100KB + 장 표식(200 만으론 SPA 대체라 무의미). RED = 직전 판 `wrangler rollback`.
10. **기록**: RELEASE-LOG 한 절 + 태그 `prod/<날짜-시각>-<판>` → main 푸시. 결과 = `done/` · `held/` · `STATUS.log`.

## 설치 (BaroOS 기준 · 다른 프로젝트는 스크립트 맨 위 값만 바꾼다)
1. `scripts/*` 를 `~/.baroos-auto/gitrunner/` 에 복사, `references/REQUEST-FORM.md` 도 같은 폴더에.
2. 작업 폴더: `git -C <본선> worktree add --detach <W> origin/main` → `npm ci`. (`gitrunner.sh` 의 `M`·`W`·`PROD`·`DEV`·`SITE`·`SB` 값)
3. 사람이 한 번: `powershell -NoProfile -ExecutionPolicy Bypass -File ~/.baroos-auto/gitrunner/register-gitrunner-task.ps1`
4. 연습: 시험 요청서를 넣고 `GR_DRY=1 bash gitrunner.sh` → `held/` 에 「연습」 결과.

## 함께 쓰는 엔진 수리 (batch-24-multiAG)
- 러너 워커가 끝난 뒤 원격 변화 비교는 **자기 갈래 이동 + 로컬 커밋을 가리키는 새 ref** 만 본다(`remoteMoved`) — 깃러너가 main 을 올려도 러너가 STOP(exit 6) 하지 않는다.
- 하향 동기 코드 충돌 = `downSyncCodeConflict: "continue"` 면 휴면 대신 `downsync-conflict.json` 을 남기고 계속.

## 절대 규칙
- 덧셈 아닌 운영 DB 변경 · 새 Edge Function 배포 · 외부 발송 · 비밀값 · 예약 실행(pg_cron)·발송 트리거는 **자동으로 하지 않는다**(held/ → 사람 승인).
- 요청 창은 직접 main 푸시·`wrangler deploy` 를 하지 않는다.
- 알림(텔레그램 등)은 보내지 않는다 — 결과는 파일로 본다(BaroOS 👤 11-11 중단 지시).
