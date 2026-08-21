# claude-skills

Claude Code 전역 스킬 백업. 두 개가 들어 있다.

| 스킬 | 하는 일 |
|---|---|
| [`auto-story-finish`](auto-story-finish/) | BMad 스토리 배치를 create → dev → review 순으로 무인 완료한다(헤드리스 `claude -p` 엔진). 단계별 모델 자동 선택, 인증 만료·사용량 한도 감지와 복구 대기, qa RED 시 중단, 옵트인 커밋·푸시(가드 하에). |
| [`dev-status`](dev-status/) | BMad v6 프로젝트의 **읽기 전용** 개발 현황판. `epics.md`·`sprint-status.yaml`·스토리 md·배치 로그를 규칙만으로 판정해 진행률·단계 배지·파일 겹침·불일치·다음 할 일을 로컬 HTML 한 장으로 낸다. 외부 의존성 0, LLM 호출 0. |

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

두 스킬 모두 Node 20 이상. 외부 npm 의존성 없음.

## ⚠️ 이 저장소는 비공개다

`auto-story-finish/SKILL.md` 에는 **내부 운영 맥락이 그대로 남아 있다** — 정책 승인자 호칭,
다른 프로젝트 이름과 그 성격, 실측 예시에 쓰인 저장소명. `dev-status` 에도 임계값 6의 근거로
쓰인 실측 출처와 원본 저장소 경로가 남아 있다.

**공개로 전환하기 전에 그 표현들을 중립적으로 바꿔야 한다.** 지금은 백업 목적의 비공개다.
