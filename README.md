# claude-skills

Claude Code 스킬 백업. 세 개가 들어 있다.

| 스킬 | 하는 일 |
|---|---|
| [`auto-story-finish`](auto-story-finish/) | BMad 스토리 배치를 create → dev → review 순으로 무인 완료한다(헤드리스 `claude -p` 엔진). 단계별 모델 자동 선택, 인증 만료·사용량 한도 감지와 복구 대기, qa RED 시 중단, 옵트인 커밋·푸시(가드 하에). |
| [`dev-status`](dev-status/) | BMad v6 프로젝트의 **읽기 전용** 개발 현황판. `epics.md`·`sprint-status.yaml`·스토리 md·배치 로그를 규칙만으로 판정해 진행률·단계 배지·파일 겹침·불일치·다음 할 일을 로컬 HTML 한 장으로 낸다. 외부 의존성 0, LLM 호출 0. |
| [`night-batch-ops`](night-batch-ops/) | **프로젝트 설치형** 24시간 무인 배치 체계 — 예약 실행(18:00+4시간 슬롯) · 큐 자동 편성(규칙 9종, LLM 0) · 연속 실행 루프 · 텔레그램/ntfy 알림. `auto-story-finish` 를 엔진으로 쓴다. 프로젝트 고유값은 설치되는 `auto.config.json` 이 소유 — 같은 엔진, 프로젝트마다 다른 설정. 설치 = 대상 프로젝트 루트에서 `node night-batch-ops/install.mjs`. |

## 설치

`~/.claude/skills/` 아래에 폴더째 두면 된다.

```bash
git clone https://github.com/uuhiuuhi/claude-skills.git
cp -r claude-skills/dev-status         ~/.claude/skills/
cp -r claude-skills/auto-story-finish  ~/.claude/skills/
```

Windows PowerShell:

```powershell
git clone https://github.com/uuhiuuhi/claude-skills.git
Copy-Item -Recurse claude-skills\dev-status        "$env:USERPROFILE\.claude\skills\"
Copy-Item -Recurse claude-skills\auto-story-finish "$env:USERPROFILE\.claude\skills\"
```

## 쓰는 법

- **현황판**: 프로젝트 폴더에서 "개발 현황판 열어줘" 라고 하거나, 직접
  `node ~/.claude/skills/dev-status/serve.mjs` (Windows: `node "$env:USERPROFILE\.claude\skills\dev-status\serve.mjs"`).
  BMad v6 산출물이 없으면 빈 화면을 그리지 않고 확인한 경로를 나열하며 종료한다.
- **배치**: "S-J 부터 S-M 까지 마무리" 처럼 스토리 범위를 말하면 된다. 자세한 계약은 각 `SKILL.md`.
- **야간 배치 체계**: 대상 프로젝트 루트에서 `node <클론>/night-batch-ops/install.mjs` → `auto.config.json` 의
  `epicOrder` 를 채우고 → (승인 후) `--register-tasks` 로 예약 등록. Claude 에게는 "이 프로젝트에
  야간 배치 적용해줘" 라고 하면 된다. 계약 전문은 `night-batch-ops/SKILL.md`.

두 스킬 모두 Node 20 이상. 외부 npm 의존성 없음.

## 표현 중립화 완료 (2026-08-27)

내부 운영 맥락이던 표현들 — 정책 승인자 호칭, 다른 프로젝트 이름과 그 성격, 실측 예시의
저장소명·경로 — 을 전부 중립 표현("승인", "한 프로젝트", "내부 프로젝트")으로 바꿨다.
실측 수치와 날짜는 근거 가치가 있어 그대로 두었다(출처만 익명화).

새 프로젝트에 받아 써도 특정 프로젝트를 가리키는 지시가 없다. 저장소는 여전히 비공개이며,
공개로 전환할 일이 생기면 그 시점에 한 번 더 전수 점검한다.
