// asf-resolve.mjs — auto-story-finish 모듈 경로 해석기(설치본 이식성 · 2026-09-03 실측 회수)
//
// 왜 있나: install.mjs 는 engine/*.mjs 를 <프로젝트>/tools/auto/ 에 **한 폴더로** 복사한다. 그런데 몇 모듈이
// `../../auto-story-finish/...` 상대 import 를 쓰고 있어, 설치본에서는 <프로젝트>/auto-story-finish/ 를 찾다
// ERR_MODULE_NOT_FOUND 로 죽었다(`node tools/auto/autofinish.mjs --diagnose-only` 실측). 저장소 배치와
// 전역 설치(~/.claude/skills/auto-story-finish/)를 순서대로 찾아 **있는 곳**의 file:// URL 을 돌려준다.
// 정적 import 대신 `await import(resolveAsf('quality-rules.mjs'))` 로 쓴다(ESM 최상위 await).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 후보 경로(순서대로). 저장소 배치(`night-batch-ops/engine/` 안)에서만 `../../auto-story-finish` 를 1순위로 두고,
 *  설치본(`tools/auto/` 등)에서는 **전역 스킬 설치본이 1순위**다 — 프로젝트 루트에 우연히 같은 이름의 폴더가
 *  있어도 그것을 엔진으로 잡지 않는다(리뷰 #13). */
export function asfCandidates(relName, { here = HERE, home = homedir() } = {}) {
  const name = String(relName ?? '').replace(/^[/\\]+/, '')
  const inRepo = basename(resolve(here, '..')) === 'night-batch-ops'
  const repo = [resolve(here, '..', '..', 'auto-story-finish', name), resolve(here, '..', 'auto-story-finish', name)]
  const global = [join(home, '.claude', 'skills', 'auto-story-finish', name)]
  return inRepo ? [...repo, ...global] : [...global, ...repo]
}

/** 존재하는 첫 후보의 file:// URL. 없으면 시도한 경로를 전부 담아 던진다(조용한 폴백 금지). */
export function resolveAsf(relName, opts = {}) {
  const tried = asfCandidates(relName, opts)
  const hit = tried.find((p) => existsSync(p))
  if (!hit) throw new Error(`auto-story-finish/${relName} 을 찾지 못했다 — 시도: ${tried.join(' · ')}`)
  return pathToFileURL(hit).href
}
