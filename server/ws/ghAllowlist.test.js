import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGhInvocation, extractGhTextFields, findBlockedGhFileArg } from './ghAllowlist.js';

const ORIGIN = 'https://github.com/testowner/testrepo.git';
const cwdOrigin = () => ORIGIN;
const REPO = 'github.com/testowner/testrepo';

describe('classifyGhInvocation: subcommand safelist', () => {
  test('allowed subcommand, implicit repo from cwd origin', () => {
    const r = classifyGhInvocation(['pr', 'view', '1'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('gh api is refused (not repo-scopable)', () => {
    const r = classifyGhInvocation(['api', '/user'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  for (const top of ['auth', 'secret', 'variable', 'ssh-key', 'gpg-key', 'gist', 'org']) {
    test(`gh ${top} is refused entirely`, () => {
      const r = classifyGhInvocation([top, 'list'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'subcommand-not-allowed');
    });
  }

  for (const sub of ['clone', 'fork', 'create', 'delete', 'rename']) {
    test(`gh repo ${sub} is refused (arbitrary target repo as bare positional)`, () => {
      const r = classifyGhInvocation(['repo', sub, 'someone/other'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'subcommand-not-allowed');
    });
  }

  test('unknown top-level command is refused', () => {
    const r = classifyGhInvocation(['completely-made-up'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('empty argv is refused', () => {
    const r = classifyGhInvocation([], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });
});

describe('classifyGhInvocation: --repo/-R resolution', () => {
  test('--repo OWNER/REPO matching the allow-listed repo', () => {
    const r = classifyGhInvocation(['issue', 'list', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('--repo pointing at an unrelated repo still resolves (allow-list check happens in the broker, not here)', () => {
    const r = classifyGhInvocation(['issue', 'list', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('-R attached form (-Rowner/repo)', () => {
    const r = classifyGhInvocation(['pr', 'list', '-Rtestowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('--repo=owner/repo form', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo=testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('--repo with HOST/OWNER/REPO form', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo', 'github.example.com/testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.example.com/testowner/testrepo']);
  });

  test('--repo with a garbage value fails to resolve', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo', 'not-a-repo-shape'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });

  test('SECURITY: repeated --repo flags surface every value (pflag keeps only the last --repo, so checking just the first would check the wrong repo)', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo', 'testowner/testrepo', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/someoneelse/unrelated', REPO].sort());
  });
});

describe('classifyGhInvocation: bundled short-flag safety (security)', () => {
  test('a standalone 2-char short flag is fine', () => {
    const r = classifyGhInvocation(['pr', 'view', '123', '-w'], cwdOrigin);
    assert.equal(r.allowed, true);
  });

  test('lone -R is fine (handled explicitly)', () => {
    const r = classifyGhInvocation(['pr', 'view', '-R', 'testowner/testrepo', '1'], cwdOrigin);
    assert.equal(r.allowed, true);
  });

  test('a bundled short flag that could be hiding -R is refused outright, even when it does not actually contain R', () => {
    // We can't know without gh's full flag schema whether "-qt" bundles a
    // hidden -R or not -- refuse conservatively either way.
    const r = classifyGhInvocation(['pr', 'view', '-qt', '1'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('SECURITY: -wR bundling -w and -R must not silently resolve to the cwd repo', () => {
    // This is the actual attack this check exists for: gh's real parser
    // (pflag/Cobra) would treat "-wR" as "-w -R", executing against
    // "someoneelse/unrelated" -- but naive parsing that only recognizes a
    // bare "-R" token would miss it and fall back to the (allow-listed) cwd
    // origin, approving a command that actually targets a different repo.
    const r = classifyGhInvocation(['pr', 'view', '-wR', 'someoneelse/unrelated', '5'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });
});

describe('classifyGhInvocation: positional URL targets (security)', () => {
  test('a PR URL to the allow-listed repo resolves to that repo, ignoring the /pull/N suffix', () => {
    const r = classifyGhInvocation(['pr', 'view', 'https://github.com/testowner/testrepo/pull/42'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('SECURITY: a PR URL to an unrelated repo is surfaced as its own repo reference, not silently defaulted to cwd', () => {
    // gh itself resolves the target repo FROM the URL, ignoring cwd/--repo
    // entirely -- classifyGhInvocation must report that repo (the caller in
    // git-broker.js is the one that actually denies it against the
    // allow-list), not the cwd's repo.
    const r = classifyGhInvocation(['pr', 'merge', 'https://github.com/someoneelse/unrelated/pull/999', '--squash'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('a plain PR number does not trigger URL handling and falls back to cwd origin', () => {
    const r = classifyGhInvocation(['pr', 'view', '42'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('a branch name (not a URL) also falls back to cwd origin', () => {
    const r = classifyGhInvocation(['pr', 'checkout', 'feature/some-branch'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });
});

describe('classifyGhInvocation: repo view bare positional (security)', () => {
  test('bare OWNER/REPO positional matching the allow-listed repo', () => {
    const r = classifyGhInvocation(['repo', 'view', 'testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('SECURITY: bare OWNER/REPO positional to an unrelated repo is surfaced, not defaulted to cwd', () => {
    const r = classifyGhInvocation(['repo', 'view', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('no positional falls back to cwd origin', () => {
    const r = classifyGhInvocation(['repo', 'view'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('a non-repo-shaped stray token (e.g. a flag value) is ignored, not treated as a repo ref', () => {
    const r = classifyGhInvocation(['repo', 'view', '--jq', '.name'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('this bare-positional handling is specific to `repo view` -- other subcommands do not treat owner/repo-shaped positionals as repo refs', () => {
    // "someone/other" here is a hypothetical branch name, not a repo ref --
    // pr checkout does not accept an owner/repo shorthand.
    const r = classifyGhInvocation(['pr', 'checkout', 'someone/other'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });
});

describe('classifyGhInvocation: no repo context at all', () => {
  test('fails closed when cwd has no origin and no explicit repo reference is given', () => {
    const r = classifyGhInvocation(['pr', 'view', '1'], () => null);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });
});

describe('classifyGhInvocation: gh run (read-only)', () => {
  test('run list falls back to cwd origin', () => {
    const r = classifyGhInvocation(['run', 'list'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('run view <run-id> falls back to cwd origin', () => {
    const r = classifyGhInvocation(['run', 'view', '123456789'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('run watch <run-id> falls back to cwd origin', () => {
    const r = classifyGhInvocation(['run', 'watch', '123456789'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('run rerun (trigger/write) is refused', () => {
    const r = classifyGhInvocation(['run', 'rerun', '123456789'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });
});

describe('classifyGhInvocation: gh api (Actions read-only)', () => {
  test('Actions GET endpoint resolves repo from cwd origin', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('SECURITY: {owner}/{repo} placeholders are refused entirely, even with --repo', () => {
    // gh fills placeholders from its own base-repo resolution (--repo /
    // GH_REPO / cwd origin) and sends the request to the host's default API
    // host, so a placeholder endpoint can target a github.com repo we never
    // checked (e.g. a cwd whose origin is a GHES remote). Only literal
    // owner/repo endpoints are supported.
    const r = classifyGhInvocation(['api', 'repos/{owner}/{repo}/actions/workflows', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });

  test('SECURITY: placeholder endpoint is refused even when cwd origin would make it look consistent', () => {
    // cwd fallback can't be used to legitimize a placeholder: gh would fill it
    // from its own resolution, not the one the broker does.
    const r = classifyGhInvocation(['api', 'repos/{owner}/{repo}/actions/runs'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });

  test('SECURITY: placeholder endpoint with a HOST/OWNER/REPO --repo is refused (would GET github.com/o/r while ghes.example.com/o/r is checked)', () => {
    const r = classifyGhInvocation(['api', 'repos/{owner}/{repo}/actions/runs', '--repo', 'ghes.example.com/testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });

  test('leading slash on the endpoint is accepted', () => {
    const r = classifyGhInvocation(['api', '/repos/testowner/testrepo/actions/runs/123/jobs'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('explicit --method=GET is still allowed', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--method=GET'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('space-separated --method GET is allowed', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--method', 'GET'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('short-flag data flag -f is refused', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '-f', 'branch=main'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('--raw-field is refused (could silently flip the default method to POST)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--raw-field', 'branch=main'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('--method POST is refused (read-only only)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--method', 'POST'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('bundled short flag -iX is refused (short flags are fully banned for api)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '-iX', 'POST'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('graphql endpoint is refused', () => {
    const r = classifyGhInvocation(['api', 'graphql', '-f', 'query=...'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('non-actions endpoint (/user) is refused', () => {
    const r = classifyGhInvocation(['api', '/user'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('non-actions repo endpoint is refused', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/issues'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('SECURITY: mixed placeholder/literal endpoint is refused (gh fills the placeholder from --repo/cwd, targeting a repo we never check)', () => {
    // repos/{owner}/unrelated/... with cwd testowner/testrepo would make gh
    // GET repos/testowner/unrelated/actions/runs while the cwd fallback only
    // checked testowner/testrepo -- a non-allow-listed repo would slip through.
    const r = classifyGhInvocation(['api', 'repos/{owner}/unrelated/actions/runs'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });

  test('SECURITY: mixed placeholder/literal with --repo is refused the same way', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/{repo}/actions/runs', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });

  test('SECURITY: placeholders in the wrong owner/repo slot are refused', () => {
    for (const endpoint of [
      'repos/{repo}/testowner/actions/runs',
      'repos/testowner/{owner}/actions/runs',
      'repos/{repo}/{owner}/actions/runs',
      'repos/{host}/testowner/actions/runs',
      'repos/%7Bowner%7D/unrelated/actions/runs',
    ]) {
      const r = classifyGhInvocation(['api', endpoint], cwdOrigin);
      assert.equal(r.allowed, false, endpoint);
      assert.equal(r.reason, 'repo-unresolved', endpoint);
    }
  });

  test('SECURITY: dot-segment traversal in an Actions endpoint is refused (raw, percent-encoded, and encoded-slash-smuggled)', () => {
    for (const endpoint of [
      'repos/testowner/testrepo/actions/runs/../../someoneelse/issues',
      'repos/testowner/testrepo/actions/runs/%2e%2e/someoneelse/issues',
      'repos/testowner/testrepo/actions/runs/%2E%2E/someoneelse/issues',
      'repos/testowner/testrepo/actions/runs/%2e./someoneelse/issues',
      'repos/testowner/testrepo/actions/runs/./runs',
      'repos/testowner/testrepo/actions/runs/%2e%2e%2fsomeoneelse/issues',
      'repos/testowner/testrepo/actions/runs/..%2f..%2fissues',
      'repos/%2e%2e/testrepo/actions/runs',
      'repos/testowner/..%2f..%2fsomeoneelse/actions/runs',
    ]) {
      const r = classifyGhInvocation(['api', endpoint], cwdOrigin);
      assert.equal(r.allowed, false, endpoint);
      assert.equal(r.reason, 'subcommand-not-allowed', endpoint);
    }
  });

  test('SECURITY: double-encoded %252e%252e stays allowed but is harmless (the server decodes once and sees a literal %2e%2e segment -> 404, and the checked repo string can never match an allow-list entry)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs/%252e%252e/someoneelse/issues'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('a query string on a literal Actions endpoint is fine (the dot-segment check ignores the query)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs?per_page=1&head=feature%2Ffix'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('SECURITY: --hostname is refused (would redirect the request off api.github.com, voiding the repo/path check)', () => {
    for (const argv of [
      ['api', 'repos/testowner/testrepo/actions/runs', '--hostname', 'ghe.example.com'],
      ['api', 'repos/testowner/testrepo/actions/runs', '--hostname=github.com'],
    ]) {
      const r = classifyGhInvocation(argv, cwdOrigin);
      assert.equal(r.allowed, false, argv.join(' '));
      assert.equal(r.reason, 'ambiguous-flags', argv.join(' '));
    }
  });

  test('SECURITY: literal endpoint plus a HOST/OWNER/REPO --repo surfaces both repos (broker denies if either is not allow-listed)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--repo', 'ghes.example.com/testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/testowner/testrepo', 'ghes.example.com/testowner/testrepo'].sort());
  });

  test('SECURITY: repeated --repo flags on gh api surface every value', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--repo', 'testowner/testrepo', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/someoneelse/unrelated', REPO].sort());
  });

  test('SECURITY: endpoint repo and a conflicting --repo are both surfaced as required references', () => {
    // Same pitfall-2 pattern as pr merge <url> --repo x: gh would call the
    // endpoint's repo regardless of --repo, so the broker must be forced to
    // check BOTH (it denies if either is not allow-listed).
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/someoneelse/unrelated', REPO].sort());
  });
});

describe('classifyGhInvocation: gh api (Security-tab alerts, read-only)', () => {
  for (const prefix of ['code-scanning/alerts', 'dependabot/alerts', 'secret-scanning/alerts']) {
    test(`${prefix}: bare listing endpoint resolves repo from cwd origin`, () => {
      const r = classifyGhInvocation(['api', `repos/testowner/testrepo/${prefix}`], cwdOrigin);
      assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
    });

    test(`${prefix}: single-alert endpoint (trailing /<number>) is allowed`, () => {
      const r = classifyGhInvocation(['api', `repos/testowner/testrepo/${prefix}/1`], cwdOrigin);
      assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
    });

    test(`${prefix}: nested sub-resource (e.g. /locations) is allowed`, () => {
      const r = classifyGhInvocation(['api', `repos/testowner/testrepo/${prefix}/1/locations`], cwdOrigin);
      assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
    });

    test(`${prefix}: leading slash is accepted`, () => {
      const r = classifyGhInvocation(['api', `/repos/testowner/testrepo/${prefix}`], cwdOrigin);
      assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
    });

    test(`SECURITY: ${prefix} with {owner}/{repo} placeholders is refused`, () => {
      const r = classifyGhInvocation(['api', `repos/{owner}/{repo}/${prefix}`, '--repo', 'testowner/testrepo'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'repo-unresolved');
    });

    test(`${prefix}: --method POST is refused (read-only only)`, () => {
      const r = classifyGhInvocation(['api', `repos/testowner/testrepo/${prefix}`, '--method', 'POST'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'ambiguous-flags');
    });

    test(`${prefix}: short-flag data flag -f is refused`, () => {
      const r = classifyGhInvocation(['api', `repos/testowner/testrepo/${prefix}`, '-f', 'state=open'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'ambiguous-flags');
    });

    test(`SECURITY: dot-segment traversal in ${prefix} is refused`, () => {
      const r = classifyGhInvocation(['api', `repos/testowner/testrepo/${prefix}/../../someoneelse/issues`], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'subcommand-not-allowed');
    });
  }

  test('SECURITY: dependabot/secrets (credential store, not alerts) is refused', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/dependabot/secrets'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('SECURITY: security-advisories (can carry embargoed text) is refused', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/security-advisories'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('SECURITY: --hostname is refused on a security-alerts endpoint too', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/secret-scanning/alerts', '--hostname', 'ghe.example.com'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('SECURITY: literal endpoint plus a conflicting --repo surfaces both repos', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/code-scanning/alerts', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/someoneelse/unrelated', REPO].sort());
  });
});

describe('classifyGhInvocation: workflow run/enable/disable require explicit repo', () => {
  test('workflow run without --repo/-R is refused (cwd fallback disabled)', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-must-be-explicit');
  });

  test('workflow enable without --repo/-R is refused', () => {
    const r = classifyGhInvocation(['workflow', 'enable', '123'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-must-be-explicit');
  });

  test('workflow disable without --repo/-R is refused', () => {
    const r = classifyGhInvocation(['workflow', 'disable', '123'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-must-be-explicit');
  });

  test('workflow run with --repo OWNER/REPO is allowed', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('workflow run with attached -R form is allowed', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '-Rtestowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('SECURITY: workflow run --repo pointing at an unrelated repo surfaces that repo (broker denies it)', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('SECURITY: repeated --repo flags surface EVERY value (pflag keeps only the last; checking only the first would bypass the explicit-repo gate)', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'testowner/testrepo', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/someoneelse/unrelated', REPO].sort());
  });

  test('regression: workflow view/list still fall back to cwd origin (no explicit-repo gate)', () => {
    assert.deepEqual(classifyGhInvocation(['workflow', 'view', '1'], cwdOrigin), { allowed: true, repos: [REPO], reason: null });
    assert.deepEqual(classifyGhInvocation(['workflow', 'list'], cwdOrigin), { allowed: true, repos: [REPO], reason: null });
  });
});

// Issue #180 (PR #179 review follow-up): every ALLOWED subcommand except
// release:create now fails closed on an unrecognized flag, the same way
// release create already did via RELEASE_CREATE_FLAGS.
describe('classifyGhInvocation: unrecognized-flag fail-closed (Issue #180)', () => {
  test('SECURITY: the exact repro from the issue -- issue close --body-file is refused (gh has no such flag today, but the broker must not silently forward it if gh ever grows one)', () => {
    const r = classifyGhInvocation(['issue', 'close', '2', '--body-file', '/etc/passwd'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'unrecognized-flag');
  });

  test('a made-up future flag is refused on a representative subcommand from each of pr/issue/release/workflow/run', () => {
    for (const argv of [
      ['pr', 'view', '1', '--some-future-flag', 'x'],
      ['issue', 'list', '--some-future-flag'],
      ['release', 'edit', 'v1', '--some-future-flag', 'x'],
      ['workflow', 'view', '1', '--some-future-flag'],
      ['run', 'list', '--some-future-flag', 'x'],
      ['repo', 'view', '--some-future-flag', 'x'],
    ]) {
      const r = classifyGhInvocation(argv, cwdOrigin);
      assert.equal(r.allowed, false, argv.join(' '));
      assert.equal(r.reason, 'unrecognized-flag', argv.join(' '));
    }
  });

  test('regression: known flags on representative subcommands are still allowed', () => {
    assert.equal(classifyGhInvocation(['issue', 'comment', '5', '-b', 'hi', '--edit-last'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['pr', 'create', '-t', 'T', '-b', 'B', '--draft', '-l', 'bug'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['pr', 'merge', '1', '--squash', '--delete-branch'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['release', 'edit', 'v1', '--title=T', '--prerelease'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'testowner/testrepo', '-f', 'k=v', '--ref', 'main'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['repo', 'view', 'testowner/testrepo', '--json', 'name'], cwdOrigin).allowed, true);
  });

  test('--help is a known (boolean) flag on every subcommand, including repo view which has no -R/--repo', () => {
    assert.equal(classifyGhInvocation(['pr', 'view', '1', '--help'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['repo', 'view', '--help'], cwdOrigin).allowed, true);
  });

  test('repo view has no -R/--repo of its own -- passing one is an unrecognized flag, not a repo reference', () => {
    const r = classifyGhInvocation(['repo', 'view', '-R', 'testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'unrecognized-flag');
  });

  test('flags that findBlockedGhFileArg blocks more specifically (--attach, --worktree, workflow -F @file) still pass THIS check as known flags, so their more specific reason survives downstream', () => {
    assert.equal(classifyGhInvocation(['pr', 'create', '-t', 'T', '--attach', '/etc/passwd'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['pr', 'checkout', '1', '--worktree', '/tmp/x'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['release', 'download', 'v1', '--dir', '/tmp/x'], cwdOrigin).allowed, true);
    assert.equal(classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'testowner/testrepo', '-F', 'k=@/etc/passwd'], cwdOrigin).allowed, true);
  });

  test('gh api is unaffected -- routed to classifyGhApi before SUBCOMMAND_FLAGS is ever consulted (its own apiRejectsFlags still governs -f/--raw-field/--hostname/--method, see the "gh api (Actions read-only)" suite above)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '-f', 'x=y'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });
});

describe('extractGhTextFields (plan8 PR-body guard)', () => {
  test('pr create: -t/-b space-separated forms', () => {
    const r = extractGhTextFields(['pr', 'create', '-t', 'My title', '-b', 'My body']);
    assert.deepEqual(r, [
      { field: 'title', kind: 'literal', value: 'My title' },
      { field: 'body', kind: 'literal', value: 'My body' },
    ]);
  });

  test('pr create: --title/--body space-separated and --body= attached forms', () => {
    const r = extractGhTextFields(['pr', 'create', '--title', 'My title', '--body=inline body']);
    assert.deepEqual(r, [
      { field: 'title', kind: 'literal', value: 'My title' },
      { field: 'body', kind: 'literal', value: 'inline body' },
    ]);
  });

  test('pr create: -F/--body-file "-" is tagged as a stdin source', () => {
    const r = extractGhTextFields(['pr', 'create', '-F', '-']);
    assert.deepEqual(r, [{ field: 'body-file', kind: 'file', value: '-' }]);
  });

  test('pr edit: --body-file <path> is tagged as a file source', () => {
    const r = extractGhTextFields(['pr', 'edit', '1', '--body-file', 'notes/body.md']);
    assert.deepEqual(r, [{ field: 'body-file', kind: 'file', value: 'notes/body.md' }]);
  });

  test('pr comment: only body/body-file, no title field', () => {
    const r = extractGhTextFields(['pr', 'comment', '5', '-b', 'nice work']);
    assert.deepEqual(r, [{ field: 'body', kind: 'literal', value: 'nice work' }]);
  });

  test('pr review: -b is a review comment body', () => {
    const r = extractGhTextFields(['pr', 'review', '5', '-c', '-b', 'looks good']);
    assert.deepEqual(r, [{ field: 'body', kind: 'literal', value: 'looks good' }]);
  });

  test('repeated flags surface every value, not just the first', () => {
    const r = extractGhTextFields(['pr', 'create', '-b', 'first', '-b', 'second']);
    assert.deepEqual(r, [
      { field: 'body', kind: 'literal', value: 'first' },
      { field: 'body', kind: 'literal', value: 'second' },
    ]);
  });

  test('a subcommand not in TEXT_FIELDS yields no fields', () => {
    assert.deepEqual(extractGhTextFields(['pr', 'view', '1']), []);
    assert.deepEqual(extractGhTextFields(['issue', 'view', '1']), []);
    assert.deepEqual(extractGhTextFields(['api', 'repos/o/r/actions/runs']), []);
  });

  test('a trailing flag with no following token contributes nothing', () => {
    assert.deepEqual(extractGhTextFields(['pr', 'create', '-b']), []);
  });

  // H2 regression: the containment pass in git-broker.js only ever sees the
  // fields extractGhTextFields returns, so a subcommand missing from
  // TEXT_FIELDS is a subcommand whose --body-file/--notes-file is never
  // checked. These cover the issue:/release:/pr:merge/close/reopen entries
  // that closed the H2 gap left by the original pr-only table.
  test('issue create/edit: title/body/body-file are tagged', () => {
    assert.deepEqual(extractGhTextFields(['issue', 'create', '-t', 'T', '-b', 'B']), [
      { field: 'title', kind: 'literal', value: 'T' },
      { field: 'body', kind: 'literal', value: 'B' },
    ]);
    assert.deepEqual(extractGhTextFields(['issue', 'edit', '1', '--body-file', 'body.md']), [
      { field: 'body-file', kind: 'file', value: 'body.md' },
    ]);
  });

  test('issue comment: -F/--body-file is a file source (H2 exfil vector)', () => {
    assert.deepEqual(extractGhTextFields(['issue', 'comment', '2', '--body-file', '/etc/passwd']), [
      { field: 'body-file', kind: 'file', value: '/etc/passwd' },
    ]);
  });

  test('issue close/reopen: -c/--comment is a literal field', () => {
    assert.deepEqual(extractGhTextFields(['issue', 'close', '2', '-c', 'done']), [
      { field: 'comment', kind: 'literal', value: 'done' },
    ]);
    assert.deepEqual(extractGhTextFields(['issue', 'reopen', '2', '--comment=again']), [
      { field: 'comment', kind: 'literal', value: 'again' },
    ]);
  });

  test('release create/edit: -n/--notes literal and -F/--notes-file file are tagged', () => {
    assert.deepEqual(extractGhTextFields(['release', 'create', 'v1', '-n', 'notes']), [
      { field: 'notes', kind: 'literal', value: 'notes' },
    ]);
    assert.deepEqual(extractGhTextFields(['release', 'edit', 'v1', '--notes-file', '../x.md']), [
      { field: 'notes-file', kind: 'file', value: '../x.md' },
    ]);
  });

  test('pr merge: subject/body/body-file are tagged', () => {
    assert.deepEqual(extractGhTextFields(['pr', 'merge', '1', '-t', 'S', '-b', 'B']), [
      { field: 'subject', kind: 'literal', value: 'S' },
      { field: 'body', kind: 'literal', value: 'B' },
    ]);
    assert.deepEqual(extractGhTextFields(['pr', 'merge', '1', '--body-file', 'body.md']), [
      { field: 'body-file', kind: 'file', value: 'body.md' },
    ]);
  });

  test('pr review: -c is a BOOLEAN flag, not a value flag, so it yields nothing', () => {
    // `gh pr review --comment -b "..."`: -c takes no value. The old generic
    // short-flag processing must not mistake it for close/reopen-style -c.
    assert.deepEqual(extractGhTextFields(['pr', 'review', '5', '-c', '-b', 'looks good']), [
      { field: 'body', kind: 'literal', value: 'looks good' },
    ]);
  });
});

// findBlockedGhFileArg (H2 follow-up -- review on #179 P1 item 1): host
// file-argument shapes TEXT_FIELDS/extractGhTextFields never notices at
// all -- release create/upload/download's own positionals and write flags,
// workflow run's -F @file, --attach, pr checkout --worktree.
describe('findBlockedGhFileArg', () => {
  test('release create: a single asset positional after the tag is blocked', () => {
    const r = findBlockedGhFileArg(['release', 'create', 'v1', '/etc/passwd']);
    assert.equal(r.reason, 'release-assets-not-allowed');
  });

  test('release create: several asset positionals (glob-expanded) are blocked', () => {
    const r = findBlockedGhFileArg(['release', 'create', 'v1', 'dist/a.tar.gz', 'dist/b.tar.gz']);
    assert.equal(r.reason, 'release-assets-not-allowed');
  });

  test('release create: tag alone, or tag + known value/boolean flags, is NOT blocked', () => {
    assert.equal(findBlockedGhFileArg(['release', 'create', 'v1']), null);
    assert.equal(findBlockedGhFileArg(['release', 'create', 'v1', '-n', 'notes', '-t', 'Title', '-d', '-p', '--generate-notes']), null);
    // --flag=value attached form must be recognized too (no extra token consumed).
    assert.equal(findBlockedGhFileArg(['release', 'create', 'v1', '--title=Title', '--target=main']), null);
    // A repeated flag (gh keeps the last) must not be misread as a positional.
    assert.equal(findBlockedGhFileArg(['release', 'create', 'v1', '-n', 'first', '-n', 'second']), null);
  });

  test('release create: a "-F/--notes-file" value still consumes its own next token (no false positive)', () => {
    // -F takes a value; its value token must not be mistaken for an asset positional.
    assert.equal(findBlockedGhFileArg(['release', 'create', 'v1', '-F', '-']), null);
  });

  test('release create: an unrecognized flag fails the WHOLE invocation closed, not just "ignored"', () => {
    const r = findBlockedGhFileArg(['release', 'create', 'v1', '--some-new-gh-flag', 'x']);
    assert.equal(r.reason, 'unrecognized-flag');
  });

  test('release create: everything after "--" is positional, including a lone asset', () => {
    const r = findBlockedGhFileArg(['release', 'create', 'v1', '--', 'asset.tar.gz']);
    assert.equal(r.reason, 'release-assets-not-allowed');
  });

  test('release download: --dir/-D is always blocked, --dir=value form too', () => {
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '--dir', '/tmp/x']).reason, 'release-download-dir-not-allowed');
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '-D', '/tmp/x']).reason, 'release-download-dir-not-allowed');
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '--dir=/tmp/x']).reason, 'release-download-dir-not-allowed');
  });

  test('release download: --output/-O must be exactly "-", --output=value form too', () => {
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '--output', '/tmp/x']).reason, 'release-download-output-not-stdout');
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '-O', '/tmp/x']).reason, 'release-download-output-not-stdout');
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '--output=/tmp/x']).reason, 'release-download-output-not-stdout');
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '--output', '-']), null);
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '--output=-']), null);
  });

  test('release download: with neither --dir nor --output is not blocked (downloads into cwd)', () => {
    assert.equal(findBlockedGhFileArg(['release', 'download', 'v1', '-p', '*.tar.gz']), null);
  });

  test('workflow run: -F/--field key=@path is blocked; key=@- (stdin) and plain values are not', () => {
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '-F', 'payload=@/etc/passwd']).reason, 'workflow-field-file-not-allowed');
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '--field', 'payload=@/etc/passwd']).reason, 'workflow-field-file-not-allowed');
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '--field=payload=@/etc/passwd']).reason, 'workflow-field-file-not-allowed');
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '-F', 'payload=@-']), null);
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '-F', 'payload=plain-string']), null);
  });

  test('workflow run: -f/--raw-field is always a literal (never file-interpreted), even with an "@" value', () => {
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '-f', 'payload=@/etc/passwd']), null);
    assert.equal(findBlockedGhFileArg(['workflow', 'run', 'deploy.yml', '--raw-field', 'payload=@/etc/passwd']), null);
  });

  test('--attach is blocked on pr/issue create/edit/comment, long and "=value" forms', () => {
    assert.equal(findBlockedGhFileArg(['pr', 'create', '--title', 't', '--attach', '/etc/passwd']).reason, 'attach-not-allowed');
    assert.equal(findBlockedGhFileArg(['pr', 'comment', '1', '--attach=/etc/passwd']).reason, 'attach-not-allowed');
    assert.equal(findBlockedGhFileArg(['issue', 'edit', '1', '--attach', '/etc/passwd']).reason, 'attach-not-allowed');
  });

  test('pr checkout --worktree is blocked, long and "=value" forms', () => {
    assert.equal(findBlockedGhFileArg(['pr', 'checkout', '1', '--worktree', '/tmp/x']).reason, 'checkout-worktree-not-allowed');
    assert.equal(findBlockedGhFileArg(['pr', 'checkout', '1', '--worktree=/tmp/x']).reason, 'checkout-worktree-not-allowed');
  });

  test('a plain pr checkout (no --worktree) is not blocked', () => {
    assert.equal(findBlockedGhFileArg(['pr', 'checkout', '1']), null);
  });

  test('subcommands this check does not apply to are left alone', () => {
    assert.equal(findBlockedGhFileArg(['pr', 'view', '1']), null);
    assert.equal(findBlockedGhFileArg(['issue', 'list']), null);
    assert.equal(findBlockedGhFileArg(['release', 'view', 'v1']), null);
  });
});

describe('ALLOWED: release upload is not on the safelist at all (H2 follow-up)', () => {
  test('release upload is refused as subcommand-not-allowed, before any file-arg check runs', () => {
    const r = classifyGhInvocation(['release', 'upload', 'v1', '/etc/passwd'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });
});
