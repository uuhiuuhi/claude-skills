# mattpocock-architecture

코드 구조 개선 스킬 묶음 — [mattpocock/skills](https://github.com/mattpocock/skills) 원본 그대로(MIT · `LICENSE`).
가져온 커밋: `49dd158d1076134a641b33efb035946536778336` (2026-10-09).

| 스킬 | 역할 | 부르는 법 |
|---|---|---|
| [`improve-codebase-architecture`](improve-codebase-architecture/) | 최근 자주 바뀐 곳을 중심으로 「얕은 모듈 → 깊은 모듈」 개선 후보를 찾아 HTML 보고서로 보여 주고, 고른 후보를 질문으로 파고든다 | 사용자가 `/improve-codebase-architecture` 로만 실행(자동 호출 꺼짐) |
| [`codebase-design`](codebase-design/) | 공용 어휘(module·interface·depth·seam·adapter·leverage·locality)와 원칙 · 대안 인터페이스 3개 병렬 설계 | 위 스킬이 호출 · 단독 사용 가능 |
| [`domain-modeling`](domain-modeling/) | `GLOSSARY.md`(업무 용어집)·`docs/adr/`(결정 기록) 작성 규칙 | 위 스킬이 호출 |
| [`grilling`](grilling/) | 결정 나무를 라운드별 번호 질문 + 추천 답으로 묻는 인터뷰 | 위 스킬이 호출 |

`improve-codebase-architecture` 는 나머지 셋을 Skill 도구로 부르므로 **네 개를 함께 설치**한다.

```powershell
$S = 'C:\Projects\claude-skills\mattpocock-architecture'
'improve-codebase-architecture','codebase-design','domain-modeling','grilling' | % { Copy-Item -Recurse -Force "$S\$_" "$env:USERPROFILE\.claude\skills\" }
```

원본을 고치지 않는다 — 갱신은 원본 저장소에서 다시 복사하고 위 커밋 번호를 바꾼다.
