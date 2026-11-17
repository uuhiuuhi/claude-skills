import test from 'node:test'
import assert from 'node:assert/strict'
import { extraCommitPaths, withExtraCommitPaths } from './commit-paths.mjs'

test('정상: 설정한 폴더가 기본 목록 뒤에 더해진다', () => {
  assert.equal(withExtraCommitPaths('src,tests', { commitPaths: ['console', 'templates/', './docs'] }), 'src,tests,console,templates,docs')
})
test('정상: 설정이 없으면 기본 목록 그대로', () => {
  assert.equal(withExtraCommitPaths('src,tests', {}), 'src,tests')
  assert.deepEqual(extraCommitPaths(undefined), [])
})
test('경계: 중복과 이미 있는 항목은 한 번만', () => {
  assert.equal(withExtraCommitPaths('src,tests', { commitPaths: ['src', 'console', 'console'] }), 'src,tests,console')
})
test('실패: invalid 항목(상위 경로·절대 경로·.git·빈 값·문자열 아님)은 버리고 알린다', () => {
  const warns = []
  assert.deepEqual(extraCommitPaths({ commitPaths: ['../x', 'C:/x', '/abs', '.git', '.git/hooks', '', 7, 'a b', 'ok/dir'] }, (m) => warns.push(m)), ['ok/dir'])
  assert.equal(warns.length, 8)
})
test('실패: invalid 배열 아님이면 무시', () => {
  assert.deepEqual(extraCommitPaths({ commitPaths: 'console' }, () => {}), [])
})
