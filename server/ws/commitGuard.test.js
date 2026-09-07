import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BLOCKED_PATTERNS, compilePatterns, findBlockedMatch, buildGuardConfig } from './commitGuard.js';

describe('compilePatterns', () => {
  test('compiles the built-in patterns without error', () => {
    const compiled = compilePatterns(DEFAULT_BLOCKED_PATTERNS);
    assert.equal(compiled.length, DEFAULT_BLOCKED_PATTERNS.length);
  });

  test('drops non-string / empty entries silently (no onInvalid call)', () => {
    let calls = 0;
    const compiled = compilePatterns([null, undefined, '', 42, {}], () => { calls++; });
    assert.deepEqual(compiled, []);
    assert.equal(calls, 0);
  });

  test('an invalid regex source is reported and dropped, valid ones survive', () => {
    const reported = [];
    const compiled = compilePatterns(['^ok$', '(unterminated', 'also-ok'], (source, err) => {
      reported.push({ source, message: err.message });
    });
    assert.deepEqual(compiled.map((c) => c.source), ['^ok$', 'also-ok']);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].source, '(unterminated');
  });
});

describe('findBlockedMatch', () => {
  test('matches a Claude-Session trailer at line start', () => {
    const compiled = compilePatterns(DEFAULT_BLOCKED_PATTERNS);
    const message = 'fix: something\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01ABC\n';
    const result = findBlockedMatch(message, compiled);
    assert.ok(result);
    assert.equal(result.source, '^Claude-Session:');
    assert.match(result.matchedLine, /^Claude-Session:/);
  });

  test('matches a bare session URL even without the Claude-Session: label', () => {
    const compiled = compilePatterns(DEFAULT_BLOCKED_PATTERNS);
    const message = 'wip\n\nsee https://claude.ai/code/session_01XYZ for context\n';
    const result = findBlockedMatch(message, compiled);
    assert.ok(result);
    assert.equal(result.source, 'https://claude\\.ai/code/session_');
  });

  test('a second, later Claude-Session line in a squash-merged message is still found', () => {
    const compiled = compilePatterns(DEFAULT_BLOCKED_PATTERNS);
    const message = [
      'feat: combine two sub-commits',
      '',
      '* first',
      '',
      'Claude-Session: https://claude.ai/code/session_first',
      '',
      '* second',
      '',
      'Claude-Session: https://claude.ai/code/session_second',
      '',
    ].join('\n');
    const result = findBlockedMatch(message, compiled);
    assert.ok(result);
    assert.equal(result.matchedLine, 'Claude-Session: https://claude.ai/code/session_first');
  });

  test('an ordinary commit message matches nothing', () => {
    const compiled = compilePatterns(DEFAULT_BLOCKED_PATTERNS);
    const message = 'fix: correct off-by-one in pagination\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n';
    assert.equal(findBlockedMatch(message, compiled), null);
  });

  test('is case-insensitive', () => {
    const compiled = compilePatterns(DEFAULT_BLOCKED_PATTERNS);
    assert.ok(findBlockedMatch('claude-session: https://claude.ai/code/session_x', compiled));
  });

  test('an operator-added pattern (opt-in Co-Authored-By block) works the same way', () => {
    const compiled = compilePatterns(['Co-Authored-By:.*noreply@anthropic\\.com']);
    const message = 'fix: x\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n';
    const result = findBlockedMatch(message, compiled);
    assert.ok(result);
    assert.equal(result.source, 'Co-Authored-By:.*noreply@anthropic\\.com');
  });
});

describe('buildGuardConfig', () => {
  test('with no user patterns, returns exactly the built-ins', () => {
    assert.deepEqual(buildGuardConfig(), { patterns: DEFAULT_BLOCKED_PATTERNS });
    assert.deepEqual(buildGuardConfig([]), { patterns: DEFAULT_BLOCKED_PATTERNS });
  });

  test('merges user patterns after the built-ins, preserving order', () => {
    const cfg = buildGuardConfig(['Co-Authored-By:.*noreply@anthropic\\.com']);
    assert.deepEqual(cfg.patterns, [...DEFAULT_BLOCKED_PATTERNS, 'Co-Authored-By:.*noreply@anthropic\\.com']);
  });

  test('non-string / empty user entries are filtered out', () => {
    const cfg = buildGuardConfig(['ok', '', null, 42, undefined]);
    assert.deepEqual(cfg.patterns, [...DEFAULT_BLOCKED_PATTERNS, 'ok']);
  });

  test('a non-array userPatterns is treated as none', () => {
    assert.deepEqual(buildGuardConfig('not-an-array'), { patterns: DEFAULT_BLOCKED_PATTERNS });
  });
});
