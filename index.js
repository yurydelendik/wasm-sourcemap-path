const repoInfoCache = {};
const cratesCache = {};

async function getRepoFromCrates(id) {
  if (cratesCache[id]) return await cratesCache[id];

  return cratesCache[id] = (async function () {
    const fetch = require('node-fetch');
  
    const repo = await fetch('https://crates.io/api/v1/crates/' + id)
       .then(res => res.json())
       .then(body => body.crate.repository);
    const m = /https:\/\/github.com\/([^\/]+)\/([^\.]+)(?:\.git)?/.exec(repo);
    return {owner: m[1], repo: m[2]};
 })();
}

async function getRepoInfo(owner, repo, tree) {
  const key = owner + '|' + repo + '|' + tree;
  if (repoInfoCache[key]) return await repoInfoCache[key];

  const result = (async function () {
  const octokit = require('@octokit/rest')();
/*
  octokit.authenticate({
    type: 'oauth',
    key: 'client_id',
    secret: 'secret'
  });
*/
  const submodules = await octokit.repos.getContents({
    owner: owner,
    repo: repo,
    ref: tree,
    path: '.gitmodules'
  }).then(result => {
    return Buffer.from(result.data.content, 'base64').toString()
  }, () => '').then(s => s.split(/\[submodule/).slice(1).map(t => {
      const m1 = /\bpath\s*=\s*([^\n]*)/.exec(t);
      const m2 = /\burl\s*=\s*https:\/\/github.com\/([^\/]+)\/([^\.\n]+)(?:\.git)?/.exec(t);
      if (!m1 || !m2) return null;
      return {path: m1[1], owner: m2[1], repo: m2[2]};
    }));

  const shas = await octokit.git.getTree({
    owner: owner,
    repo: repo,
    tree_sha: tree,
    recursive: 1
  }).then(result => {
    return result.data.tree.filter(item => item.type == "commit").reduce((acc, item) => {
      acc[item.path] = item.sha;
      return acc;
    }, {});
  });

  const result = submodules.filter(t=>t).map(t => ({path: t.path, owner: t.owner, repo: t.repo, sha: shas[t.path]}));
  return result;
  })();

  repoInfoCache[key] = result;
  return await result;
}

async function resolveRepoPath(owner, repo, tree, path) {
  const info = await getRepoInfo(owner, repo, tree);
  const f = info.find(i => path.startsWith('/' + i.path + '/'));
  if (!f)
    return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + tree + path;
  return await resolveRepoPath(f.owner, f.repo, f.sha, path.substring(f.path.length + 1));
}

function normalizePath(path) {
  if (!path.includes("/../")) return path;
  var i;
  while ((i = path.indexOf("/../")) >= 0) {
    var j = path.lastIndexOf("/", i - 1);
    path = path.substring(0, j) + path.substring(i + 3);
  }
  return path;
}

async function remapRustc(path) {
  var m = /\/rustc\/([0-9a-f]+)\/+(.*)/i.exec(path);
  if (!m) return path;
  return await resolveRepoPath("rust-lang", "rust", m[1], normalizePath("/" + m[2]));
}

async function remapCargo(path) {
  var m = /\/cargo\/registry\/src\/github.com-[0-9a-f]+\/([^\-]+)-([^\/]+)(.*)/i.exec(path);
  if (!m) return path;
  const repo = await getRepoFromCrates(m[1]);
  return await resolveRepoPath(repo.owner, repo.repo, m[2], normalizePath(m[3]));
}

async function remapDebugUrl(path) {
  if (path.startsWith("/rustc/")) {
    return await remapRustc(path);
  }
  if (path.startsWith("/cargo/registry/src/github.com-")) {
    return await remapCargo(path);
  }
  if (path.startsWith(process.cwd() + "/")) {
    return path.substring(process.cwd().length + 1);
  }
  return path;
}


if (process.argv.length <= 2) {
    console.error("USAGE: wasm-sourcemap-path <input-map> <output-map>");
    process.exit(1);
}

const input = process.argv[2];
const output = process.argv[3];

var fs = require('fs');
var map = JSON.parse(fs.readFileSync(input).toString());
Promise.all(map.sources.map(s => remapDebugUrl(s))).then(result => {
map.sources = result;
fs.writeFileSync(output, JSON.stringify(map));
});
