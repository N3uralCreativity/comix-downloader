const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const changelog = require(path.join(root, 'docs', 'changelog.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function apiCommit(index, message = `Commit ${index}`) {
  const sha = String(index).padStart(40, '0');
  return {
    sha,
    html_url: `https://github.com/N3uralCreativity/comix-downloader/commit/${sha}`,
    author: { login: 'tester' },
    commit: {
      message,
      author: { name: 'Tester', date: '2026-07-30T12:00:00Z' },
      committer: { name: 'Tester', date: '2026-07-30T12:00:00Z' }
    }
  };
}

test('classifies conventional commit prefixes', () => {
  assert.equal(changelog.classifyCommit('fix: restore downloads'), 'PATCH');
  assert.equal(changelog.classifyCommit('feat(ui): add progress'), 'ADD');
  assert.equal(changelog.classifyCommit('docs: update setup'), 'DOCS');
  assert.equal(changelog.classifyCommit('ci: validate packages'), 'CI');
});

test('classifies descriptive keywords', () => {
  assert.equal(changelog.classifyCommit('Resolved a stalled archive'), 'PATCH');
  assert.equal(changelog.classifyCommit('Remove obsolete fallback'), 'REMOVE');
  assert.equal(changelog.classifyCommit('Implement Opera packaging'), 'ADD');
  assert.equal(changelog.classifyCommit('Unclassified maintenance'), 'CHANGE');
});

test('splits commit subjects and descriptions', () => {
  assert.deepEqual(changelog.splitMessage('Short title\n\nLonger description.'), {
    title: 'Short title',
    body: 'Longer description.'
  });
});

test('matches search text and category filters', () => {
  const commit = {
    title: 'Fix mobile return',
    body: 'Restore the originating title tab.',
    author: 'N3uralCreativity',
    sha: 'abcdef123456',
    type: 'PATCH'
  };
  assert.equal(changelog.matchesCommit(commit, 'originating', 'PATCH'), true);
  assert.equal(changelog.matchesCommit(commit, 'n3ural', 'ALL'), true);
  assert.equal(changelog.matchesCommit(commit, '', 'ADD'), false);
});

test('validates and expires cached history', () => {
  const storage = {
    getItem() {
      return JSON.stringify({
        version: 1,
        savedAt: 1_000,
        commits: [{
          sha: 'abcdef1',
          title: 'fix: cached commit',
          body: '',
          date: '2026-07-30T12:00:00Z',
          author: 'Tester',
          type: 'PATCH'
        }]
      });
    }
  };
  assert.equal(changelog.readCache(storage, 1_000 + changelog.CACHE_TTL - 1).fresh, true);
  assert.equal(changelog.readCache(storage, 1_000 + changelog.CACHE_TTL).fresh, false);
  assert.equal(changelog.readCache(null), null);
});

test('rejects malformed cached commits and repairs unknown categories', () => {
  const invalidStorage = {
    getItem() {
      return JSON.stringify({ version: 1, savedAt: 1_000, commits: [{ sha: 'not-a-sha' }] });
    }
  };
  assert.equal(changelog.readCache(invalidStorage), null);

  const repairableStorage = {
    getItem() {
      return JSON.stringify({
        version: 1,
        savedAt: 1_000,
        commits: [{
          sha: 'abcdef1',
          title: 'Remove legacy code',
          body: '',
          date: '2026-07-30T12:00:00Z',
          author: 'Tester',
          type: 'UNTRUSTED'
        }]
      });
    }
  };
  assert.equal(changelog.readCache(repairableStorage, 1_000).commits[0].type, 'REMOVE');
});

test('links every public site footer and version-bump flow to the changelog', () => {
  ['index.html', 'Documentation.html', 'privacy.html', 'welcome.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(root, 'docs', file), 'utf8');
    assert.match(html, /class="changelog-btn" href="changelog\.html"/, `${file} footer`);
  });
  const bumpScript = fs.readFileSync(path.join(root, 'scripts', 'bump-version.ps1'), 'utf8');
  assert.match(bumpScript, /docs\/changelog\.html/, 'changelog version badge');
});

(async () => {
  await testAsync('fetches every GitHub page from a pinned head commit', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => apiCommit(index + 1)),
      Array.from({ length: 100 }, (_, index) => apiCommit(index + 101)),
      Array.from({ length: 7 }, (_, index) => apiCommit(index + 201))
    ];
    const urls = [];
    const commits = await changelog.fetchAllCommits(async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => pages[page - 1]
      };
    });

    assert.equal(commits.length, 207);
    assert.equal(urls.length, 3);
    assert.equal(new URL(urls[0]).searchParams.get('sha'), 'master');
    assert.equal(new URL(urls[1]).searchParams.get('sha'), pages[0][0].sha);
  });

  console.log(`\n${passed} changelog tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
