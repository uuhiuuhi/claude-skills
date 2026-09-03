# Hardening 라운드 공용 지시서 (2026-09-02 · 지휘 = Fable · 목표 = 9점대 하네스)

## 저장소·환경
- 저장소: `C:\Projects\claude-skills` (Windows 11 · Git Bash 셸 · Node 20+). 모든 작업은 이 폴더 안에서만.
- 작업 트리에 **미커밋 변경(수정 9·신규 20)** 이 이미 있다. 그 위에 덧쓴다. **절대 금지**: `git commit` · `git push` · `git stash` · `git checkout/reset/restore` · 브랜치 변경 · `~/.claude/skills/**`(전역 설치본) 수정 · `C:\Projects\jng-os*` 수정 · 실제 `claude -p`/`codex exec` 실행(`--version`·`--help`·`login status` 만 허용).
- 줄 끝은 LF 유지(현재 파일이 LF). 파일 인코딩 UTF-8(BOM 없음). Windows 경로·spawn 함정 주의(`.cmd` 심 · 공백 경로 · `NUL`).
- 테스트 = `node --test <파일…>`. 작업 중엔 **자기 소유 테스트 파일만** 돌린다(다른 워커가 동시에 다른 파일을 고치는 중이라 전체 실행은 순간적으로 깨질 수 있다). 마지막에 전체 1회: `cd /c/Projects/claude-skills && node --test $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')`. 기준선 202/202 · 38초.
- 기존 소스 앵커 테스트(`failure-classify.test.mjs` · `engine-guards.test.mjs`)가 문자열 앵커를 문다. 앵커의 **의미**를 지키되 문자열이 바뀌면 그 테스트도 같이 고친다(가드를 느슨하게 만들지 말 것).
- 스텁이 아니라 **실제 동작 테스트**(실제 프로세스 spawn · 실제 git 임시 저장소 · 실제 파일 rename)를 쓴다. 실행 못 한 검증은 PASS 가 아니라 `NOT VERIFIED` 로 보고.
- 설계 문서: `night-batch-ops/references/multi-provider-design.md`. 리뷰 원문: `night-batch-ops/references/hardening-2026-09-02/codex-review-r1.md`(finding #1~#13 · 15항목 검증표 · 누락 테스트 10종).

## 필수 정책 결정 (👤 2026-09-02 · 전부 구현 대상)
1. 추적·미추적·baseline diff 모두에서 `.env*`·키·인증정보·secret 파일 **본문**을 Codex 입력에서 완전히 제거. 최종 diff 생성 후 **전체 시크릿 마스킹을 다시** 수행.
2. QA·Claude·Codex·repair **로그에도 동일 마스킹**.
3. `.env` 하나라도 격리·복원 실패 → **fail-closed**(Codex 실행 중단 · 복원 실패도 exit 6).
4. Codex slot = **고정 slot 파일을 `wx` 로 원자 선점**. 「확인 후 별도 lock 생성」 금지.
5. 워커의 commit·push·stash·branch·reset·checkout 등 git 상태 변경을 **실행 단계에서 차단**(사후 비교만으로 안전 판정 금지).
6. 무인 `--commit` 은 **detached worktree 또는 `auto/*` 브랜치에서만**. main·일반 브랜치 직접 커밋 금지.
7. Integration Gate RED = 설정으로 우회 불가 · **무조건 rollback·STOP·push 금지**. `pushOnFail` 제거(또는 사람의 별도 승인 명령으로 분리).
8. 실행파일과 argv 분리 · **셸 문자열 결합 제거**. Windows `.cmd` 가 필요하면 안전한 전용 경로. 모델·경로·설정값의 셸 메타문자 **거부**.
9. Codex-only 작업은 Claude 인증 probe 선행 금지 — **실제 실행할 provider 만** 검사.
10. 신규 **미추적** 테스트 파일도 `.only`·skip·trivial assertion·ts-ignore·eslint-disable·테스트 삭제/약화 검사.
11. repair 전후 무결성 비교 = `rule|file` 만이 아니라 **줄 또는 정규화 내용 지문**까지.
12. 실패 worktree 제거 전에 **민감정보 제외한 실제 코드 diff + untracked 산출물**을 복구 가능한 형태로 보존.
13. security/performance trigger 켜지고 대응 script 있으면 **실제 실행** · 실패 = Quality Gate RED.
14. clean review 는 명령 개수가 아니라 **story·review diff·변경 파일을 실제로 읽은 증거**가 있어야 인정.
15. `DECISIONS-INBOX.md` 없으면 안전한 기본 형식으로 **생성** · 생성 불가면 Decision 적용 실패 처리.
16. Integration Gate 결과를 **각 story manifest 와 batch manifest 에 `pass/fail/rollback`** 으로 반영.

## 보고 형식 (워커 최종 메시지)
- 고친 finding 번호 → 파일:줄 · 무엇을 어떻게.
- 추가 테스트 → 시나리오 번호(아래 표) · 파일 · 테스트 이름 · 실제 실행 결과(통과 수 · 시간).
- 자기 소유 테스트 실행 결과 + 마지막 전체 실행 결과(실패가 다른 워커 파일이면 그 파일명 명시).
- NOT VERIFIED 항목과 이유. 다른 워커가 배선해야 하는 인터페이스(함수명·시그니처) 명시.

## 필수 테스트 시나리오 번호표
1 추적 민감 파일 diff 제외 · 2 baseline 민감 diff 제외+최종 재마스킹 · 3 두 실제 프로세스 Codex slot 원자 획득 · 4 worker 직접 push 차단 · 5 commit→reset 원상복구형 git 조작 차단 · 6 main 에서 `--commit` 차단 · 7 Integration RED 어떤 설정으로도 push 불가 · 8 공백 포함 Windows CLI 경로 · 9 셸 메타문자 model/bin/config 거부 · 10 Claude 불가·Codex 정상 Codex-only 실행 · 11 미추적 신규 테스트 `.only`/skip/trivial 탐지 · 12 `.env` 격리·복원 실패 fail-closed · 13 실패 worktree diff·untracked 복구 · 14 security/performance gate 실제 실행·실패 전파 · 15 미열람 clean review 거부 · 16 Decision inbox 부재 시 생성 · 17 manifest Integration 결과 반영 · 18 Fable 계획 검증·거부·deterministic fallback · 19 migration/schema/API contract 충돌 시 순차화 · 20 기존 Claude-only 설정·명령줄·dry-run 회귀 없음
