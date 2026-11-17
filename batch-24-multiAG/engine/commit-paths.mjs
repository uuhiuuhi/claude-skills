// 프로젝트별 「저장 허용 폴더」 더하기 — auto.config.json 의 commitPaths(문자열 배열).
// 엔진 기본 화이트리스트는 Node/Supabase 프로젝트 기준(src·tests·supabase…)이라, 코드가 다른 폴더(예: 파이썬 console/)에 있는
// 프로젝트는 스토리 커밋에 코드가 실리지 않는다. 기본 목록에 **더하기만** 한다(빼기 없음). 형식이 틀린 항목은 버리고 알린다.
const SEG = /^[A-Za-z0-9._-]+$/
export function extraCommitPaths(cfg, warn = () => {}) {
  const raw = cfg?.commitPaths
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) { warn('commitPaths 는 문자열 배열이어야 한다 — 무시'); return [] }
  const out = []
  for (const item of raw) {
    const p = typeof item === 'string' ? item.split(String.fromCharCode(92)).join('/').replace(/^\.\//, '').replace(/\/+$/, '') : ''
    const segs = p.split('/')
    const ok = p !== '' && !/^[A-Za-z]:/.test(p) && segs.every((s) => SEG.test(s) && s !== '..' && s !== '.') && segs[0] !== '.git'
    if (!ok) { warn(`commitPaths 항목(${String(item)}) 형식 불가 — 무시`); continue }
    if (!out.includes(p)) out.push(p)
  }
  return out
}
/** 기본 목록(쉼표 문자열)에 더한 최종 --commit-paths 값. 더할 것이 없으면 base 그대로. */
export const withExtraCommitPaths = (base, cfg, warn) => {
  const extra = extraCommitPaths(cfg, warn).filter((p) => !base.split(',').includes(p))
  return extra.length ? `${base},${extra.join(',')}` : base
}
