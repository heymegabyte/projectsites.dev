/**
 * @module services/__tests__/github_repo.test
 *
 * Unit tests for the GitHub repo service. All tests mock `fetch` — no real
 * GitHub API calls. Tests cover: createRepo (new + idempotent), pushBuild
 * (first commit + subsequent), getHistory, rollback, deleteRepo, repoExists,
 * and error handling.
 */
import {
  createRepo,
  pushBuild,
  getHistory,
  rollback,
  deleteRepo,
  repoExists,
  GithubRepoError,
} from '../github_repo.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ORG = 'projectsites-dev';
const SITE_ID = 'abc-123-def-456';
const TOKEN = 'ghp_test-token';
const env = { GITHUB_ORG: ORG, GITHUB_REPO_TOKEN: TOKEN };

// ── Tests ───────────────────────────────────────────────────────────────────

describe('github_repo', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  // ── createRepo ────────────────────────────────────────────────────────────

  describe('createRepo', () => {
    test('creates a new private repo and returns its HTML URL', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ html_url: `https://github.com/${ORG}/${SITE_ID}` }), {
          status: 201,
        }),
      );

      const url = await createRepo(env, SITE_ID);
      expect(url).toBe(`https://github.com/${ORG}/${SITE_ID}`);
    });

    test('returns existing repo URL when repo already exists (422 → GET)', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ errors: [{ message: 'Repository already exists' }] }), {
            status: 422,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ html_url: `https://github.com/${ORG}/${SITE_ID}` }), {
            status: 200,
          }),
        );

      const url = await createRepo(env, SITE_ID);
      expect(url).toBe(`https://github.com/${ORG}/${SITE_ID}`);
    });

    test('throws on auth failure', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
        );

      await expect(createRepo(env, SITE_ID)).rejects.toThrow(GithubRepoError);
    });

    test('throws when GITHUB_REPO_TOKEN is missing', async () => {
      await expect(createRepo({ GITHUB_ORG: ORG }, SITE_ID)).rejects.toThrow(
        'GITHUB_REPO_TOKEN is not configured',
      );
    });
  });

  // ── pushBuild ────────────────────────────────────────────────────────────

  describe('pushBuild', () => {
    const files = [{ path: 'index.html', content: '<h1>Hello</h1>' }];
    const mockSha = 'abc123def456';

    test('pushes a commit to main and returns the commit info', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        // GET refs/heads/main
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ object: { sha: mockSha } }), { status: 200 }),
        )
        // POST git/trees
        .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'tree-sha' }), { status: 201 }))
        // POST git/commits
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: 'new-commit-sha',
              html_url: `https://github.com/${ORG}/${SITE_ID}/commit/new-commit-sha`,
              author: { name: 'test', date: '2026-07-15T00:00:00Z' },
              message: 'feat: test build',
            }),
            { status: 201 },
          ),
        )
        // PATCH refs/heads/main
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const commit = await pushBuild(env, SITE_ID, files, 'feat: test build');
      expect(commit.sha).toBe('new-commit-sha');
      expect(commit.message).toBe('feat: test build');
    });

    test('handles empty repo (no main branch) by creating initial commit', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        // GET refs/heads/main → 404
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        // PUT contents/README.md → create initial commit
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ commit: { sha: 'init-sha' } }), { status: 201 }),
        )
        // POST git/trees
        .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'tree-sha' }), { status: 201 }))
        // POST git/commits
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: 'new-commit-sha',
              html_url: `https://github.com/${ORG}/${SITE_ID}/commit/new-commit-sha`,
              author: { name: 'test', date: '2026-07-15T00:00:00Z' },
              message: 'feat: first real build',
            }),
            { status: 201 },
          ),
        )
        // PATCH refs/heads/main
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const commit = await pushBuild(env, SITE_ID, files, 'feat: first real build');
      expect(commit.sha).toBe('new-commit-sha');
    });
  });

  // ── getHistory ────────────────────────────────────────────────────────────

  describe('getHistory', () => {
    test('returns commit list sorted by recency', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              sha: 'sha-1',
              commit: {
                message: 'feat: latest',
                author: { name: 'test', date: '2026-07-15T00:00:00Z' },
              },
              html_url: 'https://github.com/org/repo/commit/sha-1',
            },
            {
              sha: 'sha-2',
              commit: {
                message: 'feat: older',
                author: { name: 'test', date: '2026-07-14T00:00:00Z' },
              },
              html_url: 'https://github.com/org/repo/commit/sha-2',
            },
          ]),
          { status: 200 },
        ),
      );

      const history = await getHistory(env, SITE_ID);
      expect(history).toHaveLength(2);
      expect(history[0].sha).toBe('sha-1');
    });

    test('returns empty array when repo does not exist', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));

      const history = await getHistory(env, SITE_ID);
      expect(history).toEqual([]);
    });
  });

  // ── rollback ──────────────────────────────────────────────────────────────

  describe('rollback', () => {
    test('creates a revert commit and updates main ref', async () => {
      const targetSha = 'target-sha-123';
      jest
        .spyOn(globalThis, 'fetch')
        // GET commits/{sha}
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: targetSha,
              tree: { sha: 'target-tree-sha' },
              message: 'old commit',
            }),
            { status: 200 },
          ),
        )
        // GET refs/heads/main
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ object: { sha: 'current-sha' } }), { status: 200 }),
        )
        // POST commits (revert)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: 'revert-sha',
              html_url: `https://github.com/${ORG}/${SITE_ID}/commit/revert-sha`,
            }),
            { status: 201 },
          ),
        )
        // PATCH refs/heads/main
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const commit = await rollback(env, SITE_ID, targetSha);
      expect(commit.sha).toBe('revert-sha');
      expect(commit.message).toContain('rollback');
    });

    test('throws when target commit not found', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));

      await expect(rollback(env, SITE_ID, 'nonexistent')).rejects.toThrow(GithubRepoError);
    });

    test('throws a typed REF_FAILED (not an opaque crash) when the current-HEAD ref fetch fails (AL-778)', async () => {
      // Target commit resolves (200), but GET refs/heads/main → 404 (repo deleted mid-flight /
      // missing main ref / 403 rate-limit). Before the res.ok gate this crashed on
      // refBody.object.sha with a raw TypeError → an opaque 502; now it's a clear typed error.
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ sha: 'target', tree: { sha: 't' }, message: 'x' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
        );
      const err = await rollback(env, SITE_ID, 'target').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GithubRepoError);
      expect((err as GithubRepoError).code).toBe('REF_FAILED');
    });
  });

  // ── deleteRepo ────────────────────────────────────────────────────────────

  describe('deleteRepo', () => {
    test('deletes the repo successfully', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(deleteRepo(env, SITE_ID)).resolves.toBeUndefined();
    });

    test('swallows 404 silently', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));

      await expect(deleteRepo(env, SITE_ID)).resolves.toBeUndefined();
    });
  });

  // ── repoExists ────────────────────────────────────────────────────────────

  describe('repoExists', () => {
    test('returns true when repo returns 200', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const exists = await repoExists(env, SITE_ID);
      expect(exists).toBe(true);
    });

    test('returns false when repo returns 404', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));

      const exists = await repoExists(env, SITE_ID);
      expect(exists).toBe(false);
    });
  });
});
