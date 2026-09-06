# batch-24-multiAG

BMad 기반 프로젝트에서 Claude Fable·Opus·Sonnet과 Codex Astra·Sol·Terra를 구현·독립 리뷰 쌍으로 운용하는 24시간 배치 스킬이다. 병렬 스토리 실행, Fable 한도 시 Opus 전환, 공유 모델 상태, QA 게이트와 검증 지문을 포함한다.

전역 스킬 폴더에 복사한 뒤 대상 프로젝트 루트에서 설치한다.

```powershell
Copy-Item -Recurse .\batch-24-multiAG "$env:USERPROFILE\.claude\skills\"
node "$env:USERPROFILE\.claude\skills\batch-24-multiAG\install.mjs" --force
```

Codex에서도 같은 스킬 설명을 사용하려면 동일 폴더를 `$env:USERPROFILE\.codex\skills\`에 복사한다. 프로젝트 설치본은 `tools/auto/runtime/`에 모델 런타임을 고정하므로 전역 스킬 업데이트가 실행 중 배치에 즉시 섞이지 않는다.

정책과 운영 경계는 [SKILL.md](SKILL.md), 라우팅의 상세 근거는 [references/MODEL-ROUTING.md](references/MODEL-ROUTING.md)에 있다.
