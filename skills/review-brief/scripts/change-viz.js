#!/usr/bin/env node
// change-viz: render a standalone HTML review overview of a set of code changes.
// Sources: local working tree / local ref range / GitHub PR (gh) / Azure DevOps PR (az + temp clone) / patch file / before+after dirs.
// Never writes to the inspected repository. Output goes to --out (default %TEMP%/change-viz/<slug>).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const TMP = (() => { try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); } })();
const cp = require('child_process');
const crypto = require('crypto');
const sid = (s, n = 8) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);

const USAGE = `Usage: node change-viz.js <source> [options]

Sources (pick one; default is --repo . --uncommitted):
  --repo <path> [--uncommitted]        Working tree (staged+unstaged+untracked) vs HEAD
  --repo <path> --base <ref> --uncommitted
                                       Working tree vs merge-base(<ref>, HEAD) (whole branch incl. local edits)
  --repo <path> --base <ref> [--head <ref>]
                                       Committed range <base>...<head> (head defaults to HEAD)
  --gh-pr <url | owner/repo#N>         GitHub PR via gh CLI
  --ado-pr <url>                       Azure DevOps PR via az CLI + temporary partial clone in %TEMP%
  --patch <file>                       Any unified diff (git format)
  --before-dir <dir> --after-dir <dir> Two folder snapshots (diffed with git diff --no-index)

Options:
  --out <dir>          Output folder (default %TEMP%/change-viz/<slug>)
  --config <file>      Review config JSON (descriptions, areas, notes, diagrams, highlights)
  --title <text>       Page title (config.title wins)
  --no-diffs           Omit the per-file diff viewer (Reading path and Files become plain lists)
  --max-full-files <n> Fetch head content for at most n modified files for the "Full file" view (default 300)
  --no-game            Omit the review-quest layer (XP, ranks, achievements); it can also be toggled off in the page
  --help`;

// ---------- args ----------
function parseArgs(argv) {
  const flags = new Set(['uncommitted', 'include-diffs', 'no-diffs', 'no-game', 'help']); // include-diffs: legacy no-op, diffs are on by default
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const k = a.slice(2);
    if (flags.has(k)) o[k] = true;
    else if (i + 1 < argv.length) o[k] = argv[++i];
    else throw new Error(`Missing value for ${a}`);
  }
  return o;
}

// ---------- process helpers ----------
const IS_WIN = process.platform === 'win32';
function run(cmd, argv, opts = {}) {
  const r = cp.spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 30, shell: IS_WIN && cmd === 'az', ...opts });
  if (r.error) throw new Error(`${cmd} failed: ${r.error.message}`);
  const ok = opts.okCodes || [0];
  if (!ok.includes(r.status)) throw new Error(`${cmd} ${argv.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}
const git = (cwd, ...a) => run('git', ['-C', cwd, '-c', 'core.quotepath=off', '--no-pager', ...a]);
const gitTry = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };
const nl = (s) => (s == null ? s : s.replace(/\r\n/g, '\n'));
const isBinaryBuf = (b) => b.subarray(0, 8000).includes(0);

// ---------- sources ----------
function synthNewFile(p, buf) {
  if (isBinaryBuf(buf)) return `diff --git a/${p} b/${p}\nnew file mode 100644\nBinary files /dev/null and b/${p} differ\n`;
  const lines = nl(buf.toString('utf8')).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((x) => '+' + x).join('\n') + '\n';
}

function sourceLocal(o) {
  const repo = path.resolve(o.repo || '.');
  const top = git(repo, 'rev-parse', '--show-toplevel').trim();
  const branch = git(top, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const repoName = path.basename(top);
  const uncommitted = o.uncommitted || !o.base;
  if (uncommitted) {
    const baseRef = o.base ? git(top, 'merge-base', o.base, 'HEAD').trim() : 'HEAD';
    let patch = nl(git(top, 'diff', '-M', '--no-color', '--no-ext-diff', baseRef));
    for (const p of git(top, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
      patch += synthNewFile(p, fs.readFileSync(path.join(top, p)));
    }
    return {
      patch,
      slug: `${repoName}-${branch}-uncommitted`,
      meta: { source: o.base ? `Working tree vs merge-base(${o.base}, HEAD)` : 'Uncommitted working-tree changes vs HEAD', repo: top, branch, base: `${o.base ? o.base + ' @ ' : ''}${baseRef.slice(0, 10)}` },
      readAfter: (p) => { try { return nl(fs.readFileSync(path.join(top, p), 'utf8')); } catch { return null; } },
      readBefore: (p) => nl(gitTry(top, 'show', `${baseRef}:${p}`)),
    };
  }
  const head = o.head || 'HEAD';
  const mb = git(top, 'merge-base', o.base, head).trim();
  return {
    patch: nl(git(top, 'diff', '-M', '--no-color', '--no-ext-diff', `${o.base}...${head}`)),
    slug: `${repoName}-${o.base}...${head}`,
    meta: { source: `Committed range ${o.base}...${head}`, repo: top, branch: head, base: `${o.base} (merge-base ${mb.slice(0, 10)})` },
    readAfter: (p) => nl(gitTry(top, 'show', `${head}:${p}`)),
    readBefore: (p) => nl(gitTry(top, 'show', `${mb}:${p}`)),
  };
}

function sourceGh(o) {
  const s = o['gh-pr'];
  let m = s.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  let host = 'github.com', owner, repo, num;
  if (m) [, host, owner, repo, num] = m;
  else if ((m = s.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/))) [, owner, repo, num] = m;
  else throw new Error(`Unrecognized --gh-pr value: ${s} (use a PR URL or owner/repo#N)`);
  const R = host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`;
  const info = JSON.parse(run('gh', ['pr', 'view', num, '-R', R, '--json', 'title,url,baseRefName,headRefName,baseRefOid,headRefOid,author,state']));
  const patch = nl(run('gh', ['pr', 'diff', num, '-R', R, '--color', 'never']));
  const hostArgs = host === 'github.com' ? [] : ['--hostname', host];
  const readAt = (sha) => (p) => {
    try { return nl(run('gh', ['api', ...hostArgs, '-H', 'Accept: application/vnd.github.raw', `repos/${owner}/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`])); } catch { return null; }
  };
  return {
    patch,
    slug: `${repo}-pr${num}`,
    meta: { source: `GitHub PR #${num} (${info.state})`, repo: R, branch: info.headRefName, base: `${info.baseRefName} @ ${info.baseRefOid.slice(0, 10)}`, url: info.url, prTitle: info.title, author: info.author && info.author.login },
    readAfter: readAt(info.headRefOid),
    readBefore: readAt(info.baseRefOid),
  };
}

function sourceAdo(o) {
  const s = o['ado-pr'];
  let m = s.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i);
  let orgUrl, repoName, id;
  if (m) { orgUrl = `https://dev.azure.com/${m[1]}`; repoName = decodeURIComponent(m[3]); id = m[4]; }
  else if ((m = s.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i))) { orgUrl = `https://${m[1]}.visualstudio.com`; repoName = decodeURIComponent(m[3]); id = m[4]; }
  else throw new Error(`Unrecognized --ado-pr value: ${s} (use https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id})`);
  const info = JSON.parse(run('az', ['repos', 'pr', 'show', '--id', id, '--org', orgUrl, '-o', 'json']));
  const remote = info.repository.remoteUrl;
  const clone = path.join(TMP, 'change-viz-clones', repoName.replace(/[^\w.-]/g, '_'));
  if (!fs.existsSync(path.join(clone, '.git'))) {
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', remote, clone]);
  }
  const src = info.lastMergeSourceCommit.commitId, tgt = info.lastMergeTargetCommit.commitId;
  // Fetch the two commits into the temp clone only; fall back to the PR merge ref if SHA fetches are refused.
  let before = tgt, after = src;
  try {
    git(clone, 'fetch', '--quiet', '--depth', '50', 'origin', src, tgt);
    const mb = gitTry(clone, 'merge-base', tgt, src);
    if (mb) before = mb.trim();
  } catch {
    git(clone, 'fetch', '--quiet', '--depth', '2', 'origin', `refs/pull/${id}/merge`);
    after = git(clone, 'rev-parse', 'FETCH_HEAD').trim();
    before = git(clone, 'rev-parse', 'FETCH_HEAD^1').trim();
  }
  return {
    patch: nl(git(clone, 'diff', '-M', '--no-color', '--no-ext-diff', before, after)),
    slug: `${repoName}-pr${id}`,
    meta: { source: `Azure DevOps PR ${id} (${info.status})`, repo: `${orgUrl}/${info.repository.project.name}/_git/${repoName}`, branch: info.sourceRefName.replace('refs/heads/', ''), base: `${info.targetRefName.replace('refs/heads/', '')} @ ${before.slice(0, 10)}`, url: s, prTitle: info.title, author: info.createdBy && info.createdBy.displayName },
    readAfter: (p) => nl(gitTry(clone, 'show', `${after}:${p}`)),
    readBefore: (p) => nl(gitTry(clone, 'show', `${before}:${p}`)),
  };
}

function sourcePatch(o) {
  const f = path.resolve(o.patch);
  return { patch: nl(fs.readFileSync(f, 'utf8')), slug: path.basename(f).replace(/\.[^.]+$/, ''), meta: { source: `Patch file ${f}` }, noContent: true, readAfter: () => null, readBefore: () => null };
}

function sourceDirs(o) {
  const b = path.resolve(o['before-dir']), a = path.resolve(o['after-dir']);
  const cwd = path.dirname(b);
  const rb = path.relative(cwd, b).replace(/\\/g, '/'), ra = path.relative(cwd, a).replace(/\\/g, '/');
  let patch = nl(run('git', ['-c', 'core.quotepath=off', '--no-pager', 'diff', '--no-index', '-M', '--no-color', rb, ra], { cwd, okCodes: [0, 1] }));
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  patch = patch.replace(new RegExp(`(a/|b/|rename from |rename to )(${rx(rb)}|${rx(ra)})/`, 'gm'), '$1');
  const rd = (root) => (p) => { try { return nl(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return null; } };
  return { patch, slug: path.basename(a), meta: { source: `Folder snapshots ${b} → ${a}` }, readAfter: rd(a), readBefore: rd(b) };
}

// ---------- patch parsing ----------
function parsePatch(text) {
  const files = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const lines = chunk.replace(/\n$/, '').split('\n');
    const f = { path: null, oldPath: null, status: 'M', binary: false, add: 0, del: 0, added: [], removed: [], ctx: [], diff: chunk };
    let inHunk = false, minus = null, plus = null, rFrom = null, rTo = null;
    for (const l of lines) {
      if (!inHunk) {
        if (l.startsWith('new file mode')) f.status = 'A';
        else if (l.startsWith('deleted file mode')) f.status = 'D';
        else if (l.startsWith('rename from ')) rFrom = l.slice(12);
        else if (l.startsWith('rename to ')) rTo = l.slice(10);
        else if (l.startsWith('--- ')) minus = l.slice(4);
        else if (l.startsWith('+++ ')) plus = l.slice(4);
        else if (/^Binary files |^GIT binary patch/.test(l)) f.binary = true;
        else if (l.startsWith('@@')) inHunk = true;
        continue;
      }
      if (l.startsWith('@@')) continue;
      if (l[0] === '+') { f.add++; f.added.push(l.slice(1)); }
      else if (l[0] === '-') { f.del++; f.removed.push(l.slice(1)); }
      else if (l[0] === ' ') f.ctx.push(l.slice(1));
    }
    const strip = (p) => (p == null ? null : p.replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1').replace(/^[ab]\//, ''));
    const hdr = lines[0].match(/^diff --git a\/(.+?) b\/(.+)$/);
    const oldP = rFrom || (minus && minus !== '/dev/null' ? strip(minus) : null) || (hdr && hdr[1]);
    const newP = rTo || (plus && plus !== '/dev/null' ? strip(plus) : null) || (hdr && hdr[2]);
    if (minus === '/dev/null') f.status = 'A';
    if (plus === '/dev/null') f.status = 'D';
    if (rFrom && rTo && f.status === 'M') f.status = 'R';
    f.path = f.status === 'D' ? oldP : newP;
    f.oldPath = f.status === 'R' ? oldP : null;
    files.push(f);
  }
  return files;
}

// ---------- classification ----------
const ext = (p) => (p.match(/\.([^./]+)$/) || [, ''])[1].toLowerCase();
function langOf(p) {
  const e = ext(p);
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(e)) return 'ts';
  if (e === 'cs') return 'cs';
  if (['html', 'htm', 'cshtml', 'razor', 'xml', 'csproj', 'props', 'targets', 'config', 'resx', 'svg', 'xaml'].includes(e)) return 'markup';
  if (e === 'json') return 'json';
  if (e === 'sql') return 'sql';
  if (['css', 'scss', 'less'].includes(e)) return 'css';
  if (['yml', 'yaml'].includes(e)) return 'yaml';
  if (e === 'md') return 'md';
  return 'text';
}
function kindOf(p) {
  if (/(\.spec\.|\.test\.|\.harness\.|(^|\/)__tests__\/|(^|\/)(e2e|tests?|testing)\/|\.(Unit|Integration|Functional|Component)?Tests?(\/|\.csproj$)|Tests?\.cs$|(^|\/)test\.ts$|\.mock\.|(^|\/)mocks?\/|(^|\/)fixtures?\/)/i.test(p)) return 'test';
  if (/\.md$/i.test(p) || /(^|\/)docs?\//i.test(p)) return 'docs';
  if (/\.(csproj|sln|slnx|props|targets)$|(^|\/)(package(-lock)?\.json|nuget\.config|global\.json|angular\.json|skyuxconfig\.json|tsconfig[^/]*\.json|Dockerfile|\.editorconfig|\.gitignore)$|(^|\/)(\.github|\.azuredevops|\.pipelines?|pipelines?|deploy|infra)\/|azure-pipelines[^/]*\.ya?ml$/i.test(p)) return 'build';
  return 'prod';
}
function autoArea(p) {
  const dirs = p.split('/').slice(0, -1);
  const proj = dirs.find((d) => /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/.test(d));
  if (proj) return proj.replace(/\.(Unit|Integration|Functional|Component)?Tests?$/i, '');
  if (dirs[0] === 'src' && dirs[1] === 'app') return dirs.slice(2, 4).join('/') || 'src/app';
  if (!dirs.length) return '(root)';
  return dirs.slice(0, 2).join('/');
}
function globRe(g) {
  if (g.startsWith('/') && g.lastIndexOf('/') > 0) return new RegExp(g.slice(1, g.lastIndexOf('/')), g.slice(g.lastIndexOf('/') + 1));
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp('^' + re + (g.endsWith('/') ? '' : '($|/)'));
}
function testNames(f) {
  if (f.kind !== 'test') return null;
  const grab = (lines) => {
    const out = [];
    for (const l of lines) {
      let m;
      if (f.lang === 'ts' && (m = l.match(/\b(?:f|x)?(?:describe|it|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/))) out.push(m[2]);
      else if (f.lang === 'cs' && (m = l.match(/\bpublic\s+(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\s*\(/))) out.push(m[1]);
    }
    return out;
  };
  const a = grab(f.added), r = grab(f.removed);
  const sa = new Set(a), sr = new Set(r);
  return { added: [...new Set(a.filter((x) => !sr.has(x)))], removed: [...new Set(r.filter((x) => !sa.has(x)))] };
}

// ---------- highlighting ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KW = {
  ts: 'abstract as async await break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield',
  cs: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new null object operator out override params partial private protected public readonly record ref required return sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while with yield',
  sql: 'add alter and as asc begin by case create declare delete desc distinct drop else end exec exists from group having if in index inner insert into is join left like not null on or order outer procedure return right select set table then top union update values when where while with',
  json: 'true false null', css: '', yaml: 'true false null', md: '', text: '',
};
function tokenizer(lang) {
  const kw = new Set((KW[lang] || '').split(' ').filter(Boolean));
  const parts = [];
  if (lang === 'ts' || lang === 'cs' || lang === 'css') parts.push(['c', String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`]);
  if (lang === 'sql') parts.push(['c', String.raw`--[^\n]*|\/\*[\s\S]*?\*\/`]);
  if (lang === 'yaml') parts.push(['c', String.raw`#[^\n]*`]);
  if (lang === 'cs') parts.push(['s', String.raw`\$?@?"(?:[^"\\\n]|\\.|"")*"|'(?:[^'\\\n]|\\.)'`]);
  else parts.push(['s', String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60`]);
  if (lang === 'ts') parts.push(['d', String.raw`@\w+`]);
  if (lang === 'cs') parts.push(['d', String.raw`\[[A-Z]\w*(?=[\](])`]);
  parts.push(['n', String.raw`\b\d+(?:\.\d+)?\b`]);
  parts.push(['w', String.raw`[A-Za-z_$][\w$]*`]);
  const re = new RegExp(parts.map(([, p]) => `(${p})`).join('|'), 'gm');
  return (code) => {
    let out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(code.slice(last, m.index));
      const cls = parts[m.slice(1).findIndex((x) => x !== undefined)][0];
      const t = m[0];
      if (cls === 'w') {
        const k = lang === 'sql' ? t.toLowerCase() : t;
        out += kw.has(k) ? `<span class="k">${esc(t)}</span>` : /^[A-Z][A-Za-z0-9]*$/.test(t) && lang !== 'sql' ? `<span class="t">${esc(t)}</span>` : esc(t);
      } else out += `<span class="${cls}">${esc(t)}</span>`;
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  };
}
function hlMarkup(code) {
  return code.replace(/(<!--[\s\S]*?-->)|(<\/?[\w:.-]+)|("[^"]*")|(\/?>)|([\w:@\[\]().*#-]+)(?==)|([^<"=>]+)|([\s\S])/g, (m, c, tag, str, close, attr, txt) => {
    if (c) return `<span class="c">${esc(c)}</span>`;
    if (tag) return `<span class="k">${esc(tag)}</span>`;
    if (str) return `<span class="s">${esc(str)}</span>`;
    if (close) return `<span class="k">${esc(close)}</span>`;
    if (attr) return `<span class="d">${esc(attr)}</span>`;
    return esc(m);
  });
}
const tk = {};
function hl(code, lang) {
  if (lang === 'markup') return hlMarkup(code);
  if (!Object.prototype.hasOwnProperty.call(KW, lang)) return esc(code);
  return (tk[lang] = tk[lang] || tokenizer(lang))(code);
}

// ---------- config ----------
function loadConfig(file) {
  if (!file) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in ${file}: ${e.message}`); }
}
const joinLines = (v) => (Array.isArray(v) ? v.join('\n') : v || '');
// Page is dark-themed: map common light classDef/style fills to dark equivalents and default text to light.
const DARK_FILL = { '#e6ffec': '#12361f', '#dafbe1': '#12361f', '#ffebe9': '#4a1418', '#ffd8d3': '#4a1418', '#fff8c5': '#3b2e00', '#ddf4ff': '#0c2d4f', '#fbefff': '#2e1a47', '#f6f8fa': '#21262d', '#ffffff': '#161b22', '#fff': '#161b22' };
const darkenMermaid = (s) => s.replace(/^(\s*(?:classDef|style)\s+\S+\s+)([^\n]*)$/gm, (m, head, props) => {
  let p = props.replace(/fill:\s*(#[0-9a-fA-F]{3,6})\b/g, (x, c) => `fill:${DARK_FILL[c.toLowerCase()] || c}`);
  if (/fill:/.test(p) && !/color:/.test(p)) p = p.replace(/;?\s*$/, (e) => `,color:#e6edf3${e}`);
  return head + p;
});
function sliceMarkers(text, start, end) {
  if (!start) return { code: text.trimEnd() };
  const i = text.indexOf(start);
  if (i < 0) return { err: `start marker not found: ${start}` };
  if (end == null) return { code: text.slice(i).trimEnd() };
  const j = text.indexOf(end, i + start.length);
  if (j < 0) return { err: `end marker not found: ${end}` };
  return { code: text.slice(i, j + end.length).trimEnd() };
}
// Resolve a snippet spec ({code} | {start,end,side} | {parts:[...]}) against the change source.
function extractSnippet(h, src, warnings, label) {
  const lang = h.lang || langOf(h.file || '');
  if (h.code != null) return { lang, code: joinLines(h.code) };
  const cache = {};
  const read = (side) => (side in cache ? cache[side] : (cache[side] = (side === 'before' ? src.readBefore : src.readAfter)(h.file)));
  const parts = Array.isArray(h.parts) && h.parts.length ? h.parts : [{ start: h.start, end: h.end, side: h.side }];
  const code = parts.map((p) => {
    const side = p.side || h.side || 'after';
    const text = read(side);
    if (text == null) { warnings.push(`${label}: could not read ${side} version of ${h.file}`); return '/* file content unavailable */'; }
    const r = sliceMarkers(text, p.start, p.end);
    if (r.err) { warnings.push(`${label}: ${r.err}`); return `/* ${r.err} */`; }
    return r.code;
  }).join('\n…\n');
  return { lang, code };
}

// ---------- hotspot heuristics (suggestions only; the reviewer/agent decides) ----------
const SENSITIVE_PATH = /(contract|dto|model|schema|migration|\.sql$|controller|endpoint|route|auth|permission|security|startup|program\.cs$|appsettings|interceptor|guard|prompt|\.csproj$|package\.json$)/i;
const RISKY_ADDED = [
  [/innerHTML|bypassSecurityTrust|\beval\(|new Function\(/, 'unsafe HTML / eval'],
  [/AllowAnonymous|\[Authorize|IgnoreAntiforgery|EnableCors/, 'authorization / CORS attributes'],
  [/FromSqlRaw|ExecuteSqlRaw|SqlCommand|ExecuteNonQuery/, 'raw SQL'],
  [/prompt[^\n]*(\$"|\$@"|`|\+\s*["\w]|string\.Format|\.Append\(|\.Replace\()|untrusted|system message/i, 'LLM prompt construction'],
  [/catch\s*(\([^)]*\))?\s*\{\s*\}/, 'empty catch'],
  [/\b(TODO|FIXME|HACK)\b/, 'TODO / FIXME'],
  [/lock\s*\(|Interlocked|SemaphoreSlim|ETag|IfMatch|forkJoin|switchMap|mergeMap|concurrency/i, 'concurrency / async orchestration'],
  [/\.Result\b|\.Wait\(\)|GetAwaiter\(\)\.GetResult/, 'sync-over-async'],
  [/\bdelete\b.*\bfrom\b|DROP\s+TABLE|RemoveRange|DeleteItemAsync/i, 'data deletion'],
  [/(password|secret|api[_-]?key|connectionstring|access[_-]?token)["']?\s*[:=]\s*["'][^"']{6,}/i, 'possible hard-coded secret'],
];
const stemOf = (p) => path.basename(p).replace(/(\.spec|\.test)?\.[^.]+$/i, '').replace(/\.?tests?$/i, '').toLowerCase();
function suggestHotspots(files) {
  const testStems = new Set(files.filter((f) => f.kind === 'test').map((f) => stemOf(f.path)));
  const out = [];
  for (const f of files) {
    if (f.kind !== 'prod' || f.binary) continue;
    const reasons = [];
    let score = 0;
    const churn = f.status === 'D' ? 0 : f.add + f.del;
    if (churn >= 100) { score += Math.min(3, Math.floor(churn / 100)); reasons.push(`high churn (+${f.add} −${f.del})`); }
    if (SENSITIVE_PATH.test(f.path)) { score += 2; reasons.push('sensitive path (contract / API / auth / config)'); }
    if (f.status === 'D') { score += 1; reasons.push('deleted production file — check remaining references'); }
    const added = (f.diff || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    for (const [re, why] of RISKY_ADDED) if (re.test(added)) { score += 2; reasons.push(`added code: ${why}`); }
    if (f.status !== 'D' && f.add >= 30 && !testStems.has(stemOf(f.path))) { score += 1; reasons.push('no matching test file changed'); }
    if (score >= 2) out.push({ path: f.path, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 12);
}

// ---------- reading path: dependency-ordered "building blocks" (heuristic; config can override) ----------
// Role by file name first, then by directory: 0 models/contracts, 1 helpers, 2 services, 3 entry points/UI, 4 wiring.
const ROLE_RULES = [
  [4, /^(program|startup)\.cs$|^(main|app\.config|app\.routes)\.ts$|\.module\.ts$|routing|bootstrap|ServiceCollection|DependencyInjection|^(di|ioc|composition)$/i],
  [3, /controller|handler|endpoint|component|\.page\.|^(pages?|views?|routes?)$|worker|function|consumer|listener|trigger|\.razor$|\.cshtml/i],
  [2, /service|repositor|client|provider|store|manager|orchestrat|adapter|gateway|facade|engine|processor|\.effects?\./i],
  [1, /mapper|mapping|helper|util|resolver|validator|formatter|extension|converter|pipe\.ts$|builder|factor/i],
  [0, /model|contract|dto|enum|types?\b|\.d\.ts$|interface|option|setting|constant|schema|entit|record|request|response|event|message|payload/i],
  [0, /^I[A-Z]\w*\.cs$/],
];
const roleOf = (p) => {
  const segs = p.split('/');
  // File name first, then the nearest directory outward (so "Foo.Service/Models/X.cs" is a model, not a service).
  for (let i = segs.length - 1; i >= 0; i--) for (const [r, re] of ROLE_RULES) if (re.test(segs[i])) return r;
  return 2;
};
const ROLE_LABEL = ['models & contracts', 'helpers & mappers', 'core logic', 'entry points & UI', 'wiring & startup'];
const SYM_STOP = new Set(('Program Startup Service Services Options Settings Index Module Component Model Models Helper Helpers Utils Extensions Constants Types Base Default Main App ' +
  'Dispose DisposeAsync ToString Equals GetHashCode Configure ConfigureServices Initialize InitializeAsync Execute ExecuteAsync Handle HandleAsync Process ProcessAsync Invoke InvokeAsync ' +
  'Build Create CreateAsync Update UpdateAsync Delete DeleteAsync Get GetAsync GetAll GetAllAsync Save SaveAsync Validate Run RunAsync Start StartAsync Stop StopAsync Send SendAsync ' +
  'ngOnInit ngOnDestroy ngOnChanges ngAfterViewInit constructor default async function return string number boolean object Promise Observable Task Result Error Exception Value Values Item Items Data Request Response Context Config').split(' '));
const DEF_RES = [
  /\b(?:class|interface|record|struct|enum|trait)\s+([A-Za-z_]\w*)/g,
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|type|enum|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z]\w*)/g,
  /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z]\w*)/g,
  /\bcreate\s+(?:or\s+alter\s+)?(?:procedure|proc|function|view|table|type)\s+(?:\[?\w+\]?\.)?\[?(\w+)\]?/gi,
  /\bselector\s*:\s*['"]([a-z][\w-]*-[\w-]*)['"]/g,
];
const CS_METHOD = /^\s*(?:public|internal|protected)\s+(?:(?:static|async|virtual|override|abstract|sealed|partial|readonly|new|extern|unsafe)\s+)*[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+([A-Z]\w{4,})\s*[(<]/;
const CS_DECL = /^\s*(?:(?:public|internal|protected|abstract)\s+)*([\w<>[\],.?]+)\s+([A-Z]\w{4,})\s*(?:<[^>]*>)?\s*\([^)]*\)\s*;\s*$/;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cs|sql|py|go|java|kt|rb|swift|php|vb|fs)$/i;
const pascal = (s) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const noExt = (p) => p.replace(/\.[^./]+$/, '');

function buildReadingPath(files, cfg, warnings) {
  const live = files.filter((f) => f.status !== 'D');
  // Added + context lines with comments stripped, so mentions in comments don't create edges.
  const codeCache = new Map();
  const code = (f) => codeCache.get(f) || codeCache.set(f, f.added.concat(f.ctx).filter((l) => !/^\s*(\/\/|\/\*|\*|--|#(?!include|region|endregion))/.test(l)).map((l) => l.replace(/(^|\s)\/\/.*$/, ''))).get(f);
  // Companions (template/style next to its component, code-behind next to its view) ride along with the primary file.
  const primaryOf = new Map();
  for (const c of live) {
    if (c.kind !== 'prod' || c.binary) continue;
    const p = live.find((x) => x !== c && x.kind === 'prod' && !x.binary && ((['markup', 'css'].includes(c.lang) && ['ts', 'cs'].includes(x.lang) && noExt(x.path) === noExt(c.path)) || x.path === c.path + '.cs'));
    if (p) primaryOf.set(c, p);
  }
  const nodes = live.filter((f) => f.kind === 'prod' && !f.binary && !primaryOf.has(f));
  const groupOf = (f) => [f, ...[...primaryOf].filter(([, p]) => p === f).map(([c]) => c)];
  const tokensOf = (list) => {
    const t = new Set();
    for (const f of list) for (const l of code(f)) {
      // Enum member lines ("Name = 12,") define names rather than use them.
      if (/^\s*[A-Za-z_]\w*\s*(=\s*[-\w.|<> ]+)?,?\s*$/.test(l) && !/^\s*(return|break|continue|else)\b/.test(l)) continue;
      for (const m of l.matchAll(/[A-Za-z_$][\w$]*/g)) t.add(m[0]);
      if (f.lang === 'markup') for (const m of l.matchAll(/<([a-z][\w]*-[\w-]*)/g)) t.add(m[1]);
    }
    return t;
  };
  const importsOf = (list) => {
    const out = [];
    for (const f of list) for (const l of code(f)) for (const m of l.matchAll(/(?:\bfrom|\bimport|\brequire\(|\bimport\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1])));
    return out;
  };
  // Symbols defined by each node; keep only symbols with exactly one defining node.
  // Interface/abstract member declarations count as definitions so an interface and its implementation cancel out.
  const NOT_TYPE = new Set(['return', 'await', 'throw', 'new', 'yield', 'else', 'case', 'goto', 'using', 'var']);
  const definers = new Map();
  for (const n of nodes) {
    const syms = new Set();
    for (const f of groupOf(n)) {
      for (const l of code(f)) {
        for (const re of DEF_RES) for (const m of l.matchAll(re)) syms.add(m[1]);
        if (f.lang === 'cs') {
          let m = l.match(CS_METHOD);
          if (m) syms.add(m[1]);
          else if ((m = l.match(CS_DECL)) && !NOT_TYPE.has(m[1])) syms.add(m[2]);
        }
      }
    }
    const stem = path.posix.basename(n.path).replace(/\.[^.]+$/, '');
    if (CODE_EXT.test(n.path) && !/^index$/i.test(stem)) syms.add(n.lang === 'ts' ? pascal(stem) : stem);
    for (const s of syms) if (s.length >= 4 && !SYM_STOP.has(s) && /^[A-Za-z]/.test(s)) (definers.get(s) || definers.set(s, new Set()).get(s)).add(n);
  }
  // Namespace / package names are shared scaffolding, not dependencies.
  for (const f of files) for (const l of code(f)) {
    const m = l.match(/^\s*(?:namespace|using(?!\s+static\b)|package|import)\s+([\w.]+)\s*[;{]?\s*$/);
    if (m) for (const part of m[1].split('.')) definers.delete(part);
  }
  const symOwner = new Map([...definers].filter(([, v]) => v.size === 1).map(([s, v]) => [s, [...v][0]]));
  const byNoExt = new Map();
  for (const n of nodes) { byNoExt.set(noExt(n.path), n); if (/\/index$/.test(noExt(n.path))) byNoExt.set(noExt(n.path).replace(/\/index$/, ''), n); }
  const refsOf = (list, self) => {
    const uses = new Map();
    const add = (a, s) => { if (a && a !== self) (uses.get(a) || uses.set(a, new Set()).get(a)).add(s); };
    for (const t of tokensOf(list)) add(symOwner.get(t), t);
    for (const spec of importsOf(list)) add(byNoExt.get(spec) || byNoExt.get(noExt(spec)), 'import');
    return uses;
  };
  const deps = new Map(nodes.map((n) => [n, refsOf(groupOf(n), n)]));
  const usedBy = new Map(nodes.map((n) => [n, 0]));
  for (const d of deps.values()) for (const a of d.keys()) usedBy.set(a, usedBy.get(a) + 1);

  // Tarjan SCC so dependency cycles collapse into one level; level = longest dependency chain below it.
  let idx = 0;
  const st = [], info = new Map(), comp = new Map();
  const strong = (v) => {
    info.set(v, { i: idx, low: idx++, on: true }); st.push(v);
    for (const w of deps.get(v).keys()) {
      if (!info.has(w)) { strong(w); info.get(v).low = Math.min(info.get(v).low, info.get(w).low); }
      else if (info.get(w).on) info.get(v).low = Math.min(info.get(v).low, info.get(w).i);
    }
    if (info.get(v).low === info.get(v).i) { const c = []; let w; do { w = st.pop(); info.get(w).on = false; comp.set(w, c); c.push(w); } while (w !== v); }
  };
  for (const n of nodes) if (!info.has(n)) strong(n);
  const lvl = new Map();
  const levelOf = (c) => {
    if (lvl.has(c)) return lvl.get(c);
    lvl.set(c, 0);
    let L = 0;
    for (const v of c) for (const w of deps.get(v).keys()) if (comp.get(w) !== c) L = Math.max(L, levelOf(comp.get(w)) + 1);
    lvl.set(c, L);
    return L;
  };
  const linked = (n) => deps.get(n).size > 0 || usedBy.get(n) > 0;
  const level = new Map();
  for (const n of nodes) if (linked(n)) level.set(n, levelOf(comp.get(n)));
  const maxL = Math.max(0, ...level.values());
  const role = new Map(nodes.map((n) => [n, roleOf(n.path)]));
  const anyEdges = nodes.some(linked);
  for (const n of nodes) if (!level.has(n)) {
    const r = role.get(n);
    level.set(n, anyEdges ? (r <= 1 ? 0 : r === 2 ? Math.round(maxL / 2) : maxL) : r <= 1 ? 0 : r === 2 ? 1 : 2);
  }
  const span = anyEdges ? maxL : 2;
  if (span > 5) for (const n of nodes) level.set(n, Math.round((level.get(n) * 5) / span));
  const order = (a, b) => level.get(a) - level.get(b) || role.get(a) - role.get(b) || usedBy.get(b) - usedBy.get(a) || a.path.localeCompare(b.path);
  const sorted = [...nodes].sort(order);
  const lvls = [...new Set(sorted.map((n) => level.get(n)))];
  const steps = [];
  lvls.forEach((L, k) => {
    const ns = sorted.filter((n) => level.get(n) === L);
    const top = Object.entries(ns.reduce((a, n) => ((a[role.get(n)] = (a[role.get(n)] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => ROLE_LABEL[r]).join(' · ');
    const first = k === 0, last = k === lvls.length - 1;
    const title = lvls.length === 1 ? 'Changed code' : `${first ? 'Foundations' : last ? 'Top layer' : `Layer ${k + 1}`} · ${top}`;
    const why = !anyEdges ? 'No cross-file references detected between changed files; grouped by role (contracts → logic → entry points).'
      : lvls.length === 1 ? 'Changed code files, most-used first.'
        : first ? "These don't depend on other changed code. Read them first so later steps make sense."
          : last ? 'Pulls the earlier pieces together. Read once the building blocks are familiar.'
            : 'Builds on the steps above.';
    steps.push({ title, why, source: 'auto', files: ns.flatMap(groupOf) });
  });
  // Tests: after the code, ordered by the code file they mainly exercise.
  const tests = live.filter((f) => f.kind === 'test');
  const prodPos = new Map(steps.flatMap((s) => s.files).map((f, i) => [f, i]));
  for (const t of tests) {
    const hit = new Set([...refsOf([t], null).keys()]);
    // Main subject: the code file whose name the test is named after (longest prefix), else the deepest file it uses.
    const ts = stemOf(t.path);
    const named = nodes.filter((n) => stemOf(n.path).length >= 4 && ts.startsWith(stemOf(n.path))).sort((a, b) => stemOf(b.path).length - stemOf(a.path).length)[0];
    const byPos = [...hit].sort((a, b) => prodPos.get(a) - prodPos.get(b));
    t.subject = named || byPos[byPos.length - 1] || null;
    t.covers = (t.subject ? [t.subject] : []).concat(byPos.filter((n) => n !== t.subject)).map((n) => n.path);
  }
  const tpos = (t) => (t.subject ? prodPos.get(t.subject) : 1e9);
  if (tests.length) steps.push({ title: '🧪 Tests', why: 'Each test is placed by the code it mainly exercises (usually the file it is named after). Check that they cover the behaviour you just read.', source: 'auto', files: tests.sort((a, b) => tpos(a) - tpos(b) || a.path.localeCompare(b.path)) });
  const rest = live.filter((f) => f.kind !== 'test' && !(f.kind === 'prod' && !f.binary));
  if (rest.length) steps.push({ title: '📦 Config, build, docs & assets', why: 'Supporting changes. Skim for version bumps, new settings and pipeline changes.', source: 'auto', files: rest.sort((a, b) => a.path.localeCompare(b.path)) });
  const gone = files.filter((f) => f.status === 'D');
  if (gone.length) steps.push({ title: '🗑 Removed', why: 'Deleted files. Check that nothing still references them.', source: 'auto', files: gone.sort((a, b) => a.path.localeCompare(b.path)) });

  for (const n of nodes) {
    const u = [...deps.get(n)].map(([a, s]) => ({ path: a.path, syms: [...s].filter((x) => x !== 'import').slice(0, 3), imp: s.has('import') }));
    for (const f of groupOf(n)) { f.uses = f === n ? u : []; f.usedBy = usedBy.get(n); f.companionOf = f === n ? null : n.path; }
  }

  // Curated override: each config step takes the still-unplaced files matching its patterns (pattern order, then auto order).
  let final = steps;
  if (Array.isArray(cfg.readingPath) && cfg.readingPath.length) {
    const autoOrder = steps.flatMap((s) => s.files), placed = new Set();
    final = cfg.readingPath.map((s, i) => {
      const got = [];
      for (const pat of [].concat(s.files || [])) {
        const re = globRe(pat);
        let hit = autoOrder.filter((f) => !placed.has(f) && (f.path === pat || re.test(f.path)));
        // Broad globs keep tests and deletions in their own auto steps unless that is all they match.
        const live = hit.filter((f) => f.path === pat || (f.kind !== 'test' && f.status !== 'D'));
        if (live.length) hit = live;
        if (!hit.length) warnings.push(`readingPath step "${s.title || i + 1}": pattern matches no unplaced file: ${pat}`);
        for (const f of hit) { placed.add(f); got.push(f); }
      }
      return { title: s.title || `Step ${i + 1}`, why: joinLines(s.why), source: 'config', files: got };
    }).filter((s) => s.files.length);
    const left = steps.map((s) => ({ ...s, files: s.files.filter((f) => !placed.has(f)) })).filter((s) => s.files.length);
    const n = left.reduce((a, s) => a + s.files.length, 0);
    if (n) warnings.push(`readingPath: ${n} file(s) not covered by config were appended in auto order`);
    final = final.concat(left);
  }
  let pos = 0;
  final.forEach((s, k) => { s.n = k + 1; s.files.forEach((f, j) => { f.pos = ++pos; f.stepNo = k + 1; f.inStep = j + 1; }); });
  return final;
}

// ---------- main ----------
// Head-revision text for modified/renamed files, used by the viewer's "Full file" mode. Added and deleted files
// need no fetch because their diff already is the whole file.
const FULL_MAX_LINES = 5000, FULL_MAX_CHARS = 400000;
function loadFullFiles(files, src, max, warnings) {
  const want = files.filter((f) => !f.binary && (f.status === 'M' || f.status === 'R'));
  if (src.noContent) { for (const f of want) f.fullWhy = 'not available for a patch-file source'; return; }
  const t0 = Date.now();
  want.forEach((f, i) => {
    if (i >= max) { f.fullWhy = `skipped, over the --max-full-files limit (${max})`; return; }
    const t = src.readAfter(f.path);
    if (t == null) f.fullWhy = 'could not read the file at the head revision';
    else if (t.length > FULL_MAX_CHARS || t.split('\n').length > FULL_MAX_LINES) f.fullWhy = `file is too large to embed (limit ${FULL_MAX_LINES} lines)`;
    else f.after = t;
  });
  if (want.length > max) warnings.push(`Full-file view limited to ${max} of ${want.length} modified files; raise --max-full-files to include more.`);
  const s = (Date.now() - t0) / 1000;
  if (s > 3) console.log(`Fetched head content for ${Math.min(max, want.length)} file(s) in ${s.toFixed(1)}s`);
}

// Guided walkthrough: an authored, ordered story through the change. Each step can anchor to a file plus a line
// range, resolved here against the diff into old/new line spans that the viewer highlights.
function diffLines(f) {
  const out = [];
  let o = 0, n = 0, h = -1;
  for (const l of f.diff.replace(/\n$/, '').split('\n')) {
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { o = +m[1]; n = +m[2]; h++; continue; }
    if (h < 0 || l.startsWith('\\')) continue;
    const t = l[0] || ' ', text = l.slice(1);
    if (t === '+') out.push({ t, n: n++, text, h });
    else if (t === '-') out.push({ t, o: o++, text, h });
    else out.push({ t: ' ', o: o++, n: n++, text, h });
  }
  return out;
}
function spanOf(ls) {
  const r = {};
  const o = ls.filter((x) => x.o != null).map((x) => x.o), n = ls.filter((x) => x.n != null).map((x) => x.n);
  if (o.length) { r.o1 = Math.min(...o); r.o2 = Math.max(...o); }
  if (n.length) { r.n1 = Math.min(...n); r.n2 = Math.max(...n); }
  return r;
}
function resolveWalkthrough(cfg, files, warnings) {
  const w = Array.isArray(cfg.walkthrough) ? { steps: cfg.walkthrough } : cfg.walkthrough || {};
  const steps = (w.steps || []).map((s, i) => {
    const step = { n: i + 1, title: s.title || `Step ${i + 1}`, text: s.text || '' };
    const lbl = `walkthrough step ${i + 1} "${step.title}"`;
    if (!s.file) return step;
    let fi = files.findIndex((f) => f.path === s.file);
    if (fi < 0) {
      const m = files.map((f, j) => (('/' + f.path).endsWith('/' + s.file.replace(/^\/+/, '')) ? j : -1)).filter((j) => j >= 0);
      if (m.length === 1) fi = m[0];
      else { warnings.push(`${lbl}: file ${m.length ? 'matches several changed files' : 'is not in the change set'}: ${s.file}`); return step; }
    }
    const f = files[fi];
    Object.assign(step, { fi, path: f.path });
    if (f.binary) return step;
    const dl = diffLines(f);
    const changed = (x) => x.t !== ' ';
    let sel = [];
    if (s.lines != null) {
      const parts = Array.isArray(s.lines) ? s.lines : String(s.lines).split(/\s*[-–:]\s*/);
      const lo = +parts[0], hi = +(parts[1] || parts[0]);
      const key = (s.side || (f.status === 'D' ? 'before' : 'after')) === 'before' ? 'o' : 'n';
      if (!lo || !hi || hi < lo) { warnings.push(`${lbl}: could not parse lines "${s.lines}"`); return step; }
      // Lines that exist only on the other side are pulled in when they belong to an in-range change (git lists a
      // block's removals before its additions), so a replacement shows both halves.
      let pend = [], last = false, h = -1;
      for (const x of dl) {
        if (x.h !== h) { pend = []; last = false; h = x.h; }
        const v = x[key];
        if (v == null) { if (key === 'n') pend.push(x); else if (last) sel.push(x); continue; }
        const inR = v >= lo && v <= hi;
        if (inR) sel.push(...pend, x);
        pend = [];
        last = inR;
      }
      if (!sel.length) {
        Object.assign(step, key === 'o' ? { o1: lo, o2: hi } : { n1: lo, n2: hi });
        warnings.push(`${lbl}: lines ${lo}-${hi} are outside the diff of ${f.path}; they are highlighted in Full file mode only`);
      }
    } else if (s.find) {
      const k = dl.findIndex((x) => x.text.includes(s.find));
      if (k < 0) { warnings.push(`${lbl}: text not found in the diff of ${f.path}: ${s.find}`); return step; }
      if (s.to) {
        const e = dl.findIndex((x, j) => j >= k && x.text.includes(s.to));
        if (e < 0) warnings.push(`${lbl}: "to" text not found after "find" in ${f.path}: ${s.to}`);
        sel = dl.slice(k, e < 0 ? k + 1 : e + 1);
      } else if (s.count > 0) {
        sel = dl.slice(k, k + Math.floor(s.count));
      } else if (changed(dl[k])) {
        // The surrounding change block, unless it is huge (e.g. a new file is one block); then just the line.
        let a = k, b = k;
        while (a > 0 && changed(dl[a - 1]) && dl[a - 1].h === dl[k].h) a--;
        while (b < dl.length - 1 && changed(dl[b + 1]) && dl[b + 1].h === dl[k].h) b++;
        sel = b - a < 30 ? dl.slice(a, b + 1) : [dl[k]];
      } else sel = [dl[k]];
    } else if (s.hunk != null) {
      sel = dl.filter((x) => x.h === s.hunk - 1 && changed(x));
      if (!sel.length) warnings.push(`${lbl}: ${f.path} has no hunk ${s.hunk}`);
    }
    return Object.assign(step, spanOf(sel));
  });
  return { intro: w.intro || '', outro: w.outro || '', steps };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  const src = o['gh-pr'] ? sourceGh(o) : o['ado-pr'] ? sourceAdo(o) : o.patch ? sourcePatch(o) : o['before-dir'] || o['after-dir'] ? sourceDirs(o) : sourceLocal(o);
  const cfgPath = o.config ? path.resolve(o.config) : null;
  const cfg = loadConfig(cfgPath);
  let out = path.resolve(o.out || path.join(TMP, 'change-viz', src.slug.replace(/[^\w.-]+/g, '_')));
  fs.mkdirSync(out, { recursive: true });
  try { out = fs.realpathSync.native(out); } catch { /* keep as-is */ }
  const warnings = [];

  const areaRules = (cfg.areas || []).map((a) => ({ name: a.name, res: (a.match || []).map(globRe) }));
  const files = parsePatch(src.patch).map((f) => {
    const c = cfg.files && cfg.files[f.path];
    const co = typeof c === 'string' ? { desc: c } : c || {};
    f.lang = langOf(f.path);
    f.kind = co.kind || kindOf(f.path);
    f.desc = co.desc || '';
    f.tags = co.tags || [];
    const rule = areaRules.find((r) => r.res.some((re) => re.test(f.path)));
    f.area = co.area || (rule && rule.name) || autoArea(f.path);
    f.tests = testNames(f);
    return f;
  });
  if (!files.length) warnings.push('No changes found for this source.');
  const undescribed = files.filter((f) => !f.desc).map((f) => f.path);
  if (cfgPath && undescribed.length) warnings.push(`${undescribed.length} file(s) have no description in config: ${undescribed.join(', ')}`);
  if (cfg.files) for (const k of Object.keys(cfg.files)) if (!files.some((f) => f.path === k)) warnings.push(`config.files entry does not match any changed file: ${k}`);

  const highlights = (cfg.highlights || []).map((h) => ({ ...h, ...extractSnippet(h, src, warnings, `highlight "${h.title}"`) }));

  const LEVELS = ['high', 'medium', 'low'];
  const hotspots = (cfg.hotspots || []).map((h, i) => {
    const level = LEVELS.includes(h.level) ? h.level : 'high';
    const hsFiles = [...new Set([].concat(h.files || [], h.file || []))];
    for (const p of hsFiles) if (!files.some((f) => f.path === p)) warnings.push(`hotspot "${h.title}": file is not in the change set: ${p}`);
    const snip = h.code != null || h.start || (h.parts && h.parts.length) ? extractSnippet({ ...h, file: h.file || hsFiles[0] }, src, warnings, `hotspot "${h.title}"`) : null;
    return { ...h, level, files: hsFiles, snip, i };
  }).sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.i - b.i);
  const hotFiles = new Set(hotspots.flatMap((h) => h.files));
  for (const f of files) f.hot = hotFiles.has(f.path);
  const suggestions = suggestHotspots(files);
  const readingPath = buildReadingPath(files, cfg, warnings);
  const walkthrough = resolveWalkthrough(cfg, files, warnings);
  if (!o['no-diffs']) loadFullFiles(files, src, o['max-full-files'] != null ? Math.max(0, parseInt(o['max-full-files'], 10) || 0) : 300, warnings);

  fs.writeFileSync(path.join(out, 'changes.patch'), src.patch, 'utf8');
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
    meta: src.meta,
    totals: { files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) },
    files: files.map(({ path: p, oldPath, status, add, del, lang, kind, area, binary, tests, desc, hot }) => ({ path: p, oldPath, status, add, del, lang, kind, area, binary, tests, described: !!desc, hotspot: hot })),
    hotspotSuggestions: suggestions,
    readingPath: readingPath.map((s) => ({ title: s.title, why: s.why, source: s.source, files: s.files.map((f) => ({ path: f.path, ...(f.uses && f.uses.length ? { buildsOn: f.uses.map((u) => (u.syms.length ? `${u.path} (${u.syms.join(', ')})` : u.path)) } : {}), ...(f.companionOf ? { companionOf: f.companionOf } : {}), ...(f.covers ? { covers: f.covers } : {}) })) })),
        walkthrough: walkthrough.steps.map(({ n, title, path: p, o1, o2, n1, n2 }) => ({ n, title, ...(p ? { file: p } : {}), ...(o1 != null ? { oldLines: [o1, o2] } : {}), ...(n1 != null ? { newLines: [n1, n2] } : {}) })),
      }, null, 2), 'utf8');

      const html = render({ src, cfg, files, highlights, hotspots, suggestions, readingPath, walkthrough, diffs: !o['no-diffs'], game: !o['no-game'], title: cfg.title || o.title || src.meta.prTitle || 'Change review overview' });
  const outFile = path.join(out, 'index.html');
  fs.writeFileSync(outFile, html, 'utf8');

  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const argv = process.argv.slice(2).map((a, i, arr) => (['--config', '--repo', '--patch', '--before-dir', '--after-dir', '--out'].includes(arr[i - 1]) ? path.resolve(a) : a));
  if (!argv.includes('--out')) argv.push('--out', out);
  const cmdLine = [q(process.execPath), q(__filename), ...argv.map(q)].join(' ');
  fs.writeFileSync(path.join(out, IS_WIN ? 'regenerate.cmd' : 'regenerate.sh'), (IS_WIN ? '@echo off\r\n' : '#!/bin/sh\n') + cmdLine + (IS_WIN ? '\r\n' : '\n'), 'utf8');

  const t = files.reduce((a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a), {});
  for (const w of warnings) console.warn('WARN ' + w);
  if (cfgPath && !cfg.hotspots) console.warn('WARN config has no hotspots; add a "hotspots" array (see hotspotSuggestions in manifest.json).');
  if (!cfg.hotspots && suggestions.length) {
    console.log('Hotspot suggestions (heuristic):');
    for (const s of suggestions) console.log(`  [${s.score}] ${s.path} - ${s.reasons.join('; ')}`);
  }
  console.log(`Reading path (${readingPath.some((s) => s.source === 'config') ? 'config + auto' : 'auto'}):`);
  for (const s of readingPath) console.log(`  ${s.n}. ${s.title} (${s.files.length}): ${s.files.slice(0, 4).map((f) => path.posix.basename(f.path)).join(', ')}${s.files.length > 4 ? ', ...' : ''}`);
  console.log(`Wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB) - ${files.length} files ${JSON.stringify(t)}, +${files.reduce((s, f) => s + f.add, 0)} -${files.reduce((s, f) => s + f.del, 0)}, ${(cfg.diagrams || []).length} diagram(s), ${hotspots.length} hotspot(s)`);
  console.log(`Manifest: ${path.join(out, 'manifest.json')}`);
  console.log(`Patch:    ${path.join(out, 'changes.patch')}`);
  console.log(`Regenerate: ${path.join(out, IS_WIN ? 'regenerate.cmd' : 'regenerate.sh')}`);
}

// ---------- render ----------
// Client-side review quest: XP, ranks, achievements. State lives in localStorage keyed by a hash of the patch.
const GAME_JS = String.raw`(function(){
const B=document.body,KEY='cvz:'+B.dataset.gk,GK='cvz:game',$=id=>document.getElementById(id);
let S;try{S=JSON.parse(localStorage.getItem(KEY))||{}}catch(e){S={}}
S.done=S.done||{};S.ach=S.ach||{};
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}};
const items=[...document.querySelectorAll('[data-xp]')].map(e=>({e,id:e.dataset.q,xp:+e.dataset.xp,cat:e.dataset.cat,lv:e.dataset.lv||'',sub:e.dataset.sub||''}));
const total=items.reduce((s,i)=>s+i.xp,0)||1;
const done=i=>!!S.done[i.id],of=f=>items.filter(f),all=f=>{const a=of(f);return a.length>0&&a.every(done)};
const earned=()=>items.reduce((s,i)=>s+(done(i)?i.xp:0),0);
const isHs=i=>i.cat==='hs',isHigh=i=>isHs(i)&&i.lv==='high',isCk=i=>i.cat==='ck',isRisk=i=>i.cat==='note'&&(i.sub==='risk'||i.sub==='discrepancy'),isDg=i=>i.cat==='dg',isFile=i=>i.cat==='file',isTest=i=>isFile(i)&&i.sub==='test';
const ACH=[
['first','🌱','First steps','Earn your first XP',()=>items.some(done),items.length],
['fire','🔥','Into the fire','Clear your first hotspot',()=>of(isHs).some(done),of(isHs).length],
['marshal','🧯','Fire marshal','Clear every high-priority hotspot',()=>all(isHigh),of(isHigh).length],
['inq','❓','Inquisitor','Answer every Verify question',()=>all(isCk),of(isCk).length],
['risk','⚠️','Risk aware','Acknowledge every risk and discrepancy',()=>all(isRisk),of(isRisk).length],
['map','🗺️','Cartographer','Study every diagram',()=>all(isDg),of(isDg).length],
['tests','🧪','Test inspector','Review every changed test file',()=>all(isTest),of(isTest).length],
['sweep','🧹','Full sweep','Review every changed file',()=>all(isFile),of(isFile).length],
['master','👑','Merge master','Earn 100% of the XP',()=>earned()>=total,items.length]
].filter(a=>a[5]>0);
const RANKS=[[0,'🥚','Intern'],[10,'👀','Skimmer'],[30,'📖','Reader'],[55,'🔍','Reviewer'],[80,'🛡️','Guardian'],[100,'👑','Merge Master']];
const rankOf=p=>RANKS.reduce((r,x,i)=>p>=x[0]?i:r,0);
const calm=matchMedia('(prefers-reduced-motion: reduce)').matches;
function toast(h){const t=document.createElement('div');t.className='toast';t.innerHTML=h;$('toasts').appendChild(t);setTimeout(()=>t.remove(),3800)}
function pop(txt,el){const r=el.getBoundingClientRect(),p=document.createElement('div');p.className='xpPop';p.textContent=txt;p.style.left=(r.left+r.width/2)+'px';p.style.top=(r.top-6)+'px';B.appendChild(p);setTimeout(()=>p.remove(),1000)}
function confetti(){if(calm)return;const c=document.createElement('canvas'),x=c.getContext('2d');c.className='confetti';c.width=innerWidth;c.height=innerHeight;B.appendChild(c);
const cols=['#3fb950','#e3b341','#f85149','#4493f8','#a371f7','#ffa657'];
const ps=Array.from({length:160},()=>({x:innerWidth/2,y:innerHeight/3,vx:(Math.random()-.5)*16,vy:-4-Math.random()*12,s:5+Math.random()*5,c:cols[Math.floor(Math.random()*cols.length)],r:Math.random()*6}));
const t0=performance.now();(function f(t){x.clearRect(0,0,c.width,c.height);ps.forEach(p=>{p.vy+=.35;p.x+=p.vx;p.y+=p.vy;p.r+=.2;x.save();x.translate(p.x,p.y);x.rotate(p.r);x.fillStyle=p.c;x.fillRect(-p.s/2,-p.s/2,p.s,p.s*.6);x.restore()});if(t-t0<2600)requestAnimationFrame(f);else c.remove()})(t0)}
let lastRank=null,stepPrev={};
function pathSync(silent){
const pm=[...document.querySelectorAll('input[data-mirror]')];if(!pm.length)return;
pm.forEach(m=>{const d=!!S.done[m.dataset.q];m.checked=d;const r=m.closest('.pf');if(r)r.classList.toggle('rv-done',d)});
document.querySelectorAll('.pstep').forEach(s=>{const ms=[...s.querySelectorAll('input[data-mirror]')],k=ms.filter(m=>m.checked).length,dn=ms.length>0&&k===ms.length;const p=s.querySelector('.pst');if(p)p.textContent=dn?'✅ done':k+' / '+ms.length;s.classList.toggle('done',dn);if(!silent&&dn&&stepPrev[s.id]===false)toast('<b>🧱 Step '+s.dataset.n+' complete</b><small>'+String(s.dataset.t).replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';')+'</small>');stepPrev[s.id]=dn});
const left=pm.filter(m=>!m.checked),nx=left[0];
if($('pathCount'))$('pathCount').textContent=(pm.length-left.length)+' / '+pm.length+' read';
const pn=$('pathNext');if(pn){pn.textContent='';if(nx){const r=nx.closest('.pf'),a=document.createElement('a');a.className='pjump';a.href='#'+r.id;a.textContent=r.querySelector('a.fp').textContent.split('/').pop();pn.append('Next up: ',a)}else pn.textContent='🎉 Reading path complete'}
const nb=$('nextBtn');if(nb){nb.disabled=!nx;nb.textContent=nx?'▶ Next':'✅ Path done'}
}
function goNext(){const nx=[...document.querySelectorAll('input[data-mirror]')].find(m=>!m.checked);if(!nx)return;const r=nx.closest('.pf');if(typeof go==='function'&&go(r.id,true))return;r.scrollIntoView({block:'center'})}
function render(silent){
items.forEach(i=>{const d=done(i);if(i.e.tagName==='INPUT'){i.e.checked=d;const h=i.e.closest('.card,.notes>li,.hs-ck li');if(h)h.classList.toggle('rv-done',d)}else i.e.classList.toggle('done',d)});
document.querySelectorAll('button[data-clear]').forEach(b=>{const li=b.closest('.hs'),cks=[...li.querySelectorAll('input[data-cat=ck]')],left=cks.filter(c=>!c.checked).length,d=li.classList.contains('done');b.disabled=!d&&left>0;b.textContent=d?'✅ Cleared':left?'Answer '+left+' more to clear':'Mark cleared';b.title=d?'Click to undo':''});
const e=earned(),pct=Math.floor(100*e/total),r=rankOf(pct);
$('xpfill').style.width=pct+'%';$('xptxt').textContent=e+' / '+total+' XP';$('rank').textContent=RANKS[r][1]+' '+RANKS[r][2];
const hs=of(isHs);if($('hsCount'))$('hsCount').textContent=hs.filter(done).length+' / '+hs.length+' cleared';
if(!silent&&lastRank!==null&&r>lastRank)toast('<b>Level up!</b> '+RANKS[r][1]+' '+RANKS[r][2]);
lastRank=r;let party=false;
ACH.forEach(a=>{if(!S.ach[a[0]]&&a[4]()){S.ach[a[0]]=Date.now();if(!silent){toast('<b>🏆 Achievement unlocked</b><br>'+a[1]+' '+a[2]+'<small>'+a[3]+'</small>');if(a[0]==='marshal'||a[0]==='master')party=true}}});
$('achN').textContent=ACH.filter(a=>S.ach[a[0]]).length;$('achT').textContent=ACH.length;
$('achPanel').innerHTML='<b>Achievements</b>'+ACH.map(a=>'<div class="ach'+(S.ach[a[0]]?' on':'')+'"><span class="ai">'+a[1]+'</span><span>'+a[2]+'<small>'+a[3]+'</small></span></div>').join('');
document.querySelectorAll('input[data-pane]').forEach(c=>{c.checked=!!S.done[c.dataset.q]});
B.dataset.xp=e;B.dataset.xpTotal=total;
pathSync(silent);
if(party)confetti();
save();if(typeof apply==='function')apply();
}
document.addEventListener('change',ev=>{const t=ev.target;if(!t.matches('input[data-q]'))return;if(t.checked){S.done[t.dataset.q]=1;const src=t.dataset.xp?t:document.querySelector('[data-xp][data-q="'+t.dataset.q+'"]');pop('+'+(src?src.dataset.xp:0)+' XP',t)}else delete S.done[t.dataset.q];render()});
if($('nextBtn')){$('nextBtn').addEventListener('click',goNext);document.addEventListener('keydown',ev=>{if(ev.key==='n'&&!ev.ctrlKey&&!ev.metaKey&&!ev.altKey&&!B.classList.contains('nogame')&&!/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)){ev.preventDefault();goNext()}})}
document.querySelectorAll('button[data-clear]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.clear;if(S.done[id])delete S.done[id];else{S.done[id]=1;pop('+'+b.closest('.hs').dataset.xp+' XP 🔥',b)}render()}));
if('IntersectionObserver' in window){const io=new IntersectionObserver(es=>es.forEach(en=>{const d=en.target,id=d.dataset.q;if(!en.isIntersecting||B.classList.contains('nogame'))return;io.unobserve(d);if(!S.done[id]){S.done[id]=1;pop('+'+d.dataset.xp+' XP 🗺️',d.querySelector('h3')||d);render()}}),{threshold:.3});
document.querySelectorAll('.dg[data-q]').forEach(d=>{if(!S.done[d.dataset.q])io.observe(d)})}
const gOn=$('gameOn'),setG=on=>{B.classList.toggle('nogame',!on);B.dataset.game=on?'on':'off';gOn.checked=on;try{localStorage.setItem(GK,on?'1':'0')}catch(e){}};
let pref=null;try{pref=localStorage.getItem(GK)}catch(e){}
setG(pref!=='0');gOn.addEventListener('change',()=>{setG(gOn.checked);if(typeof apply==='function')apply()});
$('achBtn').addEventListener('click',ev=>{ev.stopPropagation();$('achPanel').classList.toggle('hidden')});
document.addEventListener('click',ev=>{const p=$('achPanel');if(!p.classList.contains('hidden')&&!p.contains(ev.target))p.classList.add('hidden')});
$('reset').addEventListener('click',()=>{if(confirm('Reset review progress for this change?')){S={done:{},ach:{}};lastRank=null;render(true)}});
render(true);
})();`;

// Page behaviour: tabs + hash routing, filters, and the split list/pane viewer. Must not contain backticks or dollar-brace.
const DGV_JS = String.raw`(function(){
const D=document.getElementById('dgv');if(!D)return;
const V=document.getElementById('dgvb'),T=document.getElementById('dgvt'),P=document.getElementById('dgvpos'),Z=document.getElementById('dgvpct');
let svg=null,home=null,saved=null,vw=1,vh=1,z=1,i=0,fitted=true,drag=null;
const pres=()=>[...document.querySelectorAll('pre.mermaid.ok')].filter(p=>p.querySelector('svg')||p===home);
function restore(){if(!svg)return;const set=(k,v)=>v==null?svg.removeAttribute(k):svg.setAttribute(k,v);
set('style',saved.style);set('width',saved.w);set('height',saved.h);home.appendChild(svg);home.style.minHeight='';svg=null;home=null}
function size(nz,cx,cy){if(!svg)return;z=Math.min(8,Math.max(.1,nz));
const br=V.getBoundingClientRect(),r=svg.getBoundingClientRect();if(cx==null){cx=V.clientWidth/2;cy=V.clientHeight/2}
const px=(br.left+cx-r.left)/(r.width||1),py=(br.top+cy-r.top)/(r.height||1);
svg.style.width=vw*z+'px';svg.style.height=vh*z+'px';
const r2=svg.getBoundingClientRect();V.scrollLeft+=r2.left+px*r2.width-(br.left+cx);V.scrollTop+=r2.top+py*r2.height-(br.top+cy);
Z.textContent=Math.round(z*100)+'%'}
function fit(){size(Math.min((V.clientWidth-40)/vw,(V.clientHeight-40)/vh));V.scrollLeft=0;V.scrollTop=0;fitted=true}
function show(k){restore();const L=pres();if(!L.length)return;i=(k+L.length)%L.length;home=L[i];svg=home.querySelector('svg');
saved={style:svg.getAttribute('style'),w:svg.getAttribute('width'),h:svg.getAttribute('height')};
const vb=svg.viewBox&&svg.viewBox.baseVal;if(vb&&vb.width){vw=vb.width;vh=vb.height}else{const b=svg.getBoundingClientRect();vw=b.width||1;vh=b.height||1}
home.style.minHeight=home.offsetHeight+'px';svg.removeAttribute('width');svg.removeAttribute('height');svg.setAttribute('style','max-width:none');
V.textContent='';V.appendChild(svg);const dg=home.closest('.dg'),h=dg&&dg.querySelector('h3');T.textContent=h?h.textContent:'Diagram';
P.textContent=(i+1)+' / '+L.length;D.querySelectorAll('[data-z=prev],[data-z=next]').forEach(b=>b.disabled=L.length<2);
if(!D.open)D.showModal();fit()}
D.addEventListener('close',restore);
document.addEventListener('click',ev=>{const t=ev.target;if(!t.closest||D.contains(t))return;const b=t.closest('.dgx,pre.mermaid.ok');if(!b)return;
const p=b.matches('pre')?b:b.closest('.dg').querySelector('pre.mermaid.ok');if(!p)return;ev.preventDefault();show(pres().indexOf(p))});
D.addEventListener('click',ev=>{if(ev.target===D){D.close();return}const b=ev.target.closest('[data-z]');if(!b)return;const a=b.dataset.z;
if(a==='close')D.close();else if(a==='prev')show(i-1);else if(a==='next')show(i+1);else if(a==='fit')fit();else{fitted=false;size(a==='one'?1:z*(a==='in'?1.25:0.8))}});
D.addEventListener('keydown',ev=>{if(ev.key==='Escape')return;ev.stopPropagation();const m={'+':'in','=':'in','-':'out','_':'out','0':'fit','1':'one',ArrowLeft:'prev',ArrowRight:'next'}[ev.key];
if(!m)return;ev.preventDefault();if(m==='prev')show(i-1);else if(m==='next')show(i+1);else if(m==='fit')fit();else{fitted=false;size(m==='one'?1:z*(m==='in'?1.25:0.8))}});
V.addEventListener('wheel',ev=>{if(!svg)return;ev.preventDefault();const br=V.getBoundingClientRect();fitted=false;size(z*Math.exp(-ev.deltaY*0.0015),ev.clientX-br.left,ev.clientY-br.top)},{passive:false});
V.addEventListener('pointerdown',ev=>{if(ev.button)return;drag={x:ev.clientX,y:ev.clientY,l:V.scrollLeft,t:V.scrollTop};V.setPointerCapture(ev.pointerId);V.classList.add('drag')});
V.addEventListener('pointermove',ev=>{if(!drag)return;V.scrollLeft=drag.l-(ev.clientX-drag.x);V.scrollTop=drag.t-(ev.clientY-drag.y)});
const end=()=>{drag=null;V.classList.remove('drag')};V.addEventListener('pointerup',end);V.addEventListener('pointercancel',end);
V.addEventListener('dblclick',ev=>{const br=V.getBoundingClientRect();fitted=false;size(z*2,ev.clientX-br.left,ev.clientY-br.top)});
addEventListener('resize',()=>{if(D.open&&fitted)fit()});
})();`;

const APP_JS = String.raw`(function(){
const B=document.body,H=document.querySelector('header'),$=id=>document.getElementById(id);
const q=$('q'),ht=$('hideTests'),ho=$('hotOnly'),hd=$('hideDone');
function apply(){const v=q.value.trim().toLowerCase(),h=ho&&ho.checked,d=hd&&hd.checked&&!B.classList.contains('nogame');document.querySelectorAll('[data-search]').forEach(e=>{const hide=(ht.checked&&e.dataset.kind==='test')||(h&&e.dataset.hot!=='1')||(d&&e.classList.contains('rv-done')&&!e.classList.contains('sel'))||(v&&!e.dataset.search.includes(v));e.classList.toggle('hidden',!!hide)});document.querySelectorAll('.pane').forEach(pos)}
q.addEventListener('input',apply);ht.addEventListener('change',apply);if(ho)ho.addEventListener('change',apply);if(hd)hd.addEventListener('change',apply);
function reveal(t){if(!t)return;if(t.classList.contains('hidden')){q.value='';ht.checked=false;if(ho)ho.checked=false;if(hd)hd.checked=false;apply()}const d=t.closest('details');if(d)d.open=true}
function flash(el){if(!el)return;el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash')}
const setHH=()=>B.style.setProperty('--hh',H.offsetHeight+'px');
addEventListener('resize',setHH);
const tabs=[...document.querySelectorAll('section.tab')];
let cur=null,mode='d',lay='u';
try{if(localStorage.getItem('cvz:view')==='f')mode='f';if(localStorage.getItem('cvz:layout')==='s')lay='s'}catch(e){}
const rows=sp=>[...sp.querySelectorAll('.list [data-fi]')].filter(r=>!r.classList.contains('hidden'));
function pos(p){const sp=p.closest('.split'),r=sp.querySelector('.list .sel'),rs=rows(sp),i=r?rs.indexOf(r):-1,nb=p.querySelectorAll('.ptool button[data-nav]');
p.querySelector('.ppos').textContent=i<0?'':(i+1)+' / '+rs.length;nb[0].disabled=i<=0;nb[1].disabled=!rs.length||i>=rs.length-1}
function toFirst(p,win){if(!p.offsetParent)return;const v=(mode==='f'&&p.querySelector('.vf'))||p.querySelector('.vd')||p,tb=v.querySelector(lay==='s'?'table.sbs':'table.diff:not(.sbs)'),c=tb&&(tb.querySelector('tr.wt')||(mode==='f'&&v.classList.contains('vf')&&tb.querySelector('tr.ad,tr.dl,tr.ch')));if(!c)return;if(p.scrollHeight>p.clientHeight){p.scrollTop+=c.getBoundingClientRect().top-p.getBoundingClientRect().top-p.querySelector('.ptool').offsetHeight-60;return}if(!win)return;const y=c.getBoundingClientRect().top;if(y<H.offsetHeight||y>innerHeight-40)scrollBy(0,y-H.offsetHeight-90)}
function mark(b,d){if(d.o1==null&&d.n1==null)return;const o1=+(d.o1||0),o2=+(d.o2||-1),n1=+(d.n1||0),n2=+(d.n2||-1);
b.querySelectorAll('table.diff:not(.sbs)').forEach(tb=>{const tr=[...tb.rows];let a=-1,z=-1;tr.forEach((x,i)=>{if(x.classList.contains('hk')||x.cells.length<3)return;const ov=+x.cells[0].textContent,nv=+x.cells[1].textContent;if((ov&&ov>=o1&&ov<=o2)||(nv&&nv>=n1&&nv<=n2)){if(a<0)a=i;z=i}});
for(let i=a;a>=0&&i<=z;i++)if(!tr[i].classList.contains('hk'))tr[i].classList.add('wt')})}
// Split (side-by-side) layout is derived from the unified table: removals go left, additions right, paired in order.
function toSplit(t){const s=document.createElement('table');s.className='diff sbs'+(t.classList.contains('full')?' full':'');
s.innerHTML='<colgroup><col class="cn"><col><col class="cn"><col></colgroup>';const bd=s.createTBody();
const code=r=>r.cells[2].innerHTML.slice(1);
const half=(tr,num,cls,html)=>{const n=tr.insertCell();n.className='ln';n.textContent=num;const c=tr.insertCell();if(cls)c.className=cls;c.innerHTML=html};
let dq=[],aq=[],nq=[];
const flush=()=>{for(let i=0;i<Math.max(dq.length,aq.length);i++){const d=dq[i],a=aq[i],tr=bd.insertRow();
tr.className='ch'+((d&&d.classList.contains('wt'))||(a&&a.classList.contains('wt'))?' wt':'');
half(tr,d?d.cells[0].textContent:'',d?'dl':'em',d?code(d):'');half(tr,a?a.cells[1].textContent:'',a?'ad':'em',a?code(a):'')}dq=[];aq=[];
[...new Set(nq)].forEach(h=>{const tr=bd.insertRow();tr.className='hk';const c=tr.insertCell();c.colSpan=4;c.innerHTML=h});nq=[]};
for(const r of t.rows){if(r.classList.contains('dl')){if(aq.length)flush();dq.push(r);continue}if(r.classList.contains('ad')){aq.push(r);continue}
const last=r.cells[r.cells.length-1];if(r.classList.contains('hk')&&last.textContent.charAt(0)==='\\'){nq.push(last.innerHTML);continue}flush();
const tr=bd.insertRow();if(r.classList.contains('hk')){tr.className='hk';const c=tr.insertCell();c.colSpan=4;c.innerHTML=last.innerHTML;continue}
if(r.classList.contains('wt'))tr.className='wt';half(tr,r.cells[0].textContent,'',code(r));half(tr,r.cells[1].textContent,'',code(r))}
flush();t.after(s)}
function ensureSplit(p){if(lay!=='s')return;p.querySelectorAll('.pbody table.diff:not(.sbs)').forEach(t=>{const n=t.nextElementSibling;if(!(n&&n.classList.contains('sbs')))toSplit(t)})}
function setMode(m){mode=m;try{localStorage.setItem('cvz:view',m)}catch(e){}
document.querySelectorAll('.pane').forEach(p=>{p.classList.toggle('full',m==='f');p.querySelectorAll('.seg button[data-mode]').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));p.scrollTop=0;toFirst(p)})}
function setLayout(l){lay=l;try{localStorage.setItem('cvz:layout',l)}catch(e){}
document.querySelectorAll('.pane').forEach(p=>{p.classList.toggle('sbs',l==='s');p.querySelectorAll('.seg button[data-lay]').forEach(b=>b.classList.toggle('on',b.dataset.lay===l));ensureSplit(p);p.scrollTop=0;toFirst(p)})}
function copyStep(b){const txt=b.dataset.copy,lbl=b.dataset.lbl||(b.dataset.lbl=b.textContent),done=ok=>{b.classList.add(ok?'ok':'err');b.textContent=ok?'✓ Copied':'Copy failed';setTimeout(()=>{b.classList.remove('ok','err');b.textContent=lbl},1500)};
const legacy=()=>{const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';B.appendChild(ta);ta.select();let ok=false;try{ok=document.execCommand('copy')}catch(e){}ta.remove();done(ok)};
if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(txt).then(()=>done(true),legacy);else legacy()}
function select(r,quiet){const sp=r.closest('.split');reveal(r);if(!sp)return;
sp.querySelectorAll('.list .sel').forEach(x=>x.classList.remove('sel'));r.classList.add('sel');
const p=sp.querySelector('.pane'),b=p.querySelector('.pbody'),t=$('fv'+r.dataset.fi);
b.textContent='';if(t)b.appendChild(t.content.cloneNode(true));mark(b,r.dataset);ensureSplit(p);
const pc=b.querySelector('input[data-pane]');if(pc){const c=document.querySelector('input[data-xp][data-q="'+pc.dataset.q+'"]');pc.checked=!!(c&&c.checked)}
pos(p);p.scrollTop=0;toFirst(p,!quiet);
const l=sp.querySelector('.list'),lr=l.getBoundingClientRect(),rr=r.getBoundingClientRect();
if(l.scrollHeight>l.clientHeight&&(rr.top<lr.top||rr.bottom>lr.bottom))l.scrollTop+=rr.top-lr.top-lr.height/3;
if(!quiet)flash(r)}
function activate(id,auto){const s=$(id);if(!s||!s.classList.contains('tab'))return false;
tabs.forEach(t=>t.classList.toggle('on',t===s));
document.querySelectorAll('nav.tabs a').forEach(a=>a.classList.toggle('on',a.dataset.tab===id));
B.dataset.tab=id;cur=s;setHH();
const sp=s.querySelector('.split');
if(auto&&sp&&!sp.querySelector('.list .sel')){const rs=rows(sp),r=rs.find(x=>!x.classList.contains('rv-done'))||rs[0];if(r)select(r,true)}
return true}
function go(id,push){if(!id)return false;const el=$(id);if(!el)return false;const sec=el.closest('section.tab');if(!sec)return false;
const changed=sec!==cur;activate(sec.id,el===sec);
if(push)history.pushState(null,'','#'+id);
if(el===sec){scrollTo(0,0);return true}
const sp=el.matches('[data-fi]')&&el.closest('.split');
if(sp){select(el);const y=sp.getBoundingClientRect().top+scrollY-H.offsetHeight-8;if(changed||sp.getBoundingClientRect().top>H.offsetHeight+8)scrollTo(0,Math.max(0,y));return true}
reveal(el);if(changed)scrollTo(0,0);el.scrollIntoView({block:'center'});flash(el);return true}
function step(sp,d){if(!sp)return;const rs=rows(sp),i=rs.indexOf(sp.querySelector('.list .sel')),n=rs[i<0?0:Math.min(rs.length-1,Math.max(0,i+d))];if(n&&!n.classList.contains('sel')){select(n);history.replaceState(null,'','#'+n.id)}}
document.addEventListener('click',ev=>{const t=ev.target;if(!t.closest)return;
const a=t.closest('a[href^="#"]');if(a){let id=a.getAttribute('href').slice(1);try{id=decodeURIComponent(id)}catch(e){}if(go(id,true))ev.preventDefault();return}
const cb=t.closest('button[data-copy]');if(cb){copyStep(cb);return}
const tb=t.closest('.ptool button');if(tb){if(tb.dataset.mode)setMode(tb.dataset.mode);else if(tb.dataset.lay)setLayout(tb.dataset.lay);else step(tb.closest('.split'),+tb.dataset.nav);return}
const r=t.closest('.split .list [data-fi]');
if(r&&!t.closest('input,label,button,summary,a')&&!String(getSelection()).length){select(r);history.replaceState(null,'','#'+r.id)}});
document.addEventListener('keydown',ev=>{if(ev.ctrlKey||ev.metaKey||ev.altKey||/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName))return;const sp=cur&&cur.querySelector('.split');if(!sp)return;
if(ev.key==='j'||ev.key==='k'){ev.preventDefault();step(sp,ev.key==='j'?1:-1)}else if(ev.key==='f'){ev.preventDefault();setMode(mode==='f'?'d':'f')}else if(ev.key==='s'){ev.preventDefault();setLayout(lay==='s'?'u':'s')}});
// Draggable divider between the list and the pane; width is a % of the split, shared by every tab and remembered.
function setLW(px,sp,save){let v=null;if(px!=null){const w=sp.getBoundingClientRect().width;v=Math.min(Math.max(px,220),w-372)/w*100}
if(v==null)B.style.removeProperty('--lw');else B.style.setProperty('--lw',v.toFixed(2)+'%');
if(save)try{if(v==null)localStorage.removeItem('cvz:listw');else localStorage.setItem('cvz:listw',v.toFixed(2))}catch(e){}}
try{const v=parseFloat(localStorage.getItem('cvz:listw'));if(v>0&&v<100)B.style.setProperty('--lw',v+'%')}catch(e){}
document.addEventListener('pointerdown',ev=>{const g=ev.target.closest&&ev.target.closest('.split>.gut');if(!g||ev.button)return;ev.preventDefault();
const sp=g.parentElement;g.setPointerCapture(ev.pointerId);B.classList.add('resizing');
const mv=e=>setLW(e.clientX-sp.getBoundingClientRect().left-6,sp),up=e=>{B.classList.remove('resizing');setLW(e.clientX-sp.getBoundingClientRect().left-6,sp,true);g.removeEventListener('pointermove',mv);g.removeEventListener('pointerup',up);g.removeEventListener('pointercancel',up)};
g.addEventListener('pointermove',mv);g.addEventListener('pointerup',up);g.addEventListener('pointercancel',up)});
document.addEventListener('dblclick',ev=>{const g=ev.target.closest&&ev.target.closest('.split>.gut');if(g)setLW(null,g.parentElement,true)});
document.addEventListener('keydown',ev=>{const g=ev.target.closest&&ev.target.closest('.split>.gut');if(!g||(ev.key!=='ArrowLeft'&&ev.key!=='ArrowRight'))return;ev.preventDefault();ev.stopPropagation();
const sp=g.parentElement;setLW(sp.querySelector('.list').getBoundingClientRect().width+(ev.key==='ArrowLeft'?-24:24),sp,true)},true);
const route=()=>{let id=location.hash.slice(1);try{id=decodeURIComponent(id)}catch(e){}if(!go(id))activate('summary')};
addEventListener('popstate',route);
if('scrollRestoration' in history)history.scrollRestoration='manual';
setMode(mode);setLayout(lay);setHH();route();addEventListener('load',()=>{setHH();if(location.hash.length>1)route()});
window.apply=apply;window.reveal=reveal;window.go=go;window.flash=flash;
})();`;

function render({ src, cfg, files, highlights, hotspots, suggestions, readingPath, walkthrough, diffs, game, title }) {
  const idxOf = new Map(files.map((f, i) => [f.path, i]));
  const fid = (p) => `f-${idxOf.has(p) ? idxOf.get(p) : -1}`;
  const rp = readingPath || [];
  const pathOrder = rp.flatMap((s) => s.files);
  // Review-quest layer: everything is emitted through G() so --no-game omits it entirely.
  const G = (s) => (game ? s : '');
  const HS_XP = { high: 60, medium: 40, low: 25 };
  const NOTE_XP = { risk: 15, discrepancy: 15, warn: 10, info: 5 };
  const fileXp = (f) => (f.kind === 'test' ? 1 + Math.min(3, Math.floor((f.add + f.del) / 100)) : 2 + Math.min(8, Math.floor((f.add + f.del) / 50)));
  const reviewBox = (f) => G(` <label class="g rv" title="Mark this file as reviewed"><input type="checkbox" data-q="f-${sid(f.path)}" data-xp="${fileXp(f)}" data-cat="file" data-sub="${f.kind}"> reviewed</label>`);
  const clearBtn = (id) => G(`<button class="g gbtn" data-clear="${id}">Mark cleared</button>`);
  const KIND_ORDER = ['prod', 'test', 'build', 'docs'];
  const areaOrder = [...(cfg.areas || []).map((a) => a.name)];
  for (const f of files) if (!areaOrder.includes(f.area)) areaOrder.push(f.area);
  const byArea = {};
  const tot = { A: 0, M: 0, D: 0, R: 0, add: 0, del: 0, prod: 0, test: 0, build: 0, docs: 0 };
  for (const f of files) {
    const a = (byArea[f.area] = byArea[f.area] || { n: 0, A: 0, M: 0, D: 0, R: 0, add: 0, del: 0 });
    a.n++; a[f.status]++; a.add += f.add; a.del += f.del;
    tot[f.status]++; tot.add += f.add; tot.del += f.del; tot[f.kind] = (tot[f.kind] || 0) + 1;
  }
  const badge = (s) => `<span class="b b${s}" title="${{ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' }[s]}">${s}</span>`;
  const delta = (f) => (f.binary ? '<span class="kind">binary</span>' : `<span class="pa">+${f.add}</span> <span class="pd">&minus;${f.del}</span>`);
  const testList = (f) => (f.tests && (f.tests.added.length || f.tests.removed.length) ?
    `<div class="tests">${f.tests.removed.map((x) => `<div class="tr">&minus; ${esc(x)}</div>`).join('')}${f.tests.added.map((x) => `<div class="ta">+ ${esc(x)}</div>`).join('')}</div>` : '');
  const srch = (f) => esc((f.path + ' ' + (f.oldPath || '') + ' ' + f.desc + ' ' + f.tags.join(' ')).toLowerCase());

  let fileMap = '';
  for (const area of areaOrder) {
    const list = files.filter((f) => f.area === area).sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.path.localeCompare(y.path));
    if (!list.length) continue;
    const x = byArea[area];
    fileMap += `<div class="area"><h3>${esc(area)} <small>${x.n} files · +${x.add} &minus;${x.del}</small></h3>`;
    for (const f of list) {
      const nx = f.pos ? pathOrder[f.pos] : null;
      const pathBits = f.pos ? ` <a class="pjump pchip" href="#p-${f.pos}" title="Reading path: step ${f.stepNo}, file ${f.inStep}">🧱 ${f.stepNo}.${f.inStep}</a>` : '';
      const nextBit = nx ? ` <a class="pjump pnext" href="#${fid(nx.path)}" title="Next in reading path: ${esc(nx.path)}">next →</a>` : '';
      fileMap += `<div class="card ${f.kind}${f.hot ? ' hot' : ''}" id="${fid(f.path)}" data-fi="${idxOf.get(f.path)}" data-kind="${f.kind}" data-hot="${f.hot ? 1 : 0}" data-search="${srch(f)}">${badge(f.status)} <span class="fp">${esc(f.path)}</span>${f.oldPath ? ` <span class="kind">from ${esc(f.oldPath)}</span>` : ''} <span class="kind">${f.kind}</span>${pathBits}${f.hot ? ' <a class="hot-tag" href="#hotspots" title="Listed in Hotspots">🔥 hotspot</a>' : ''}${f.tags.map((t) => ` <span class="tag">${esc(t)}</span>`).join('')} ${delta(f)}${reviewBox(f)}${nextBit}
<div class="desc">${f.desc ? esc(f.desc) : '<i>(no description)</i>'}</div>${testList(f)}</div>\n`;
    }
    fileMap += '</div>';
  }

  const areaRows = areaOrder.filter((a) => byArea[a]).map((a) => {
    const x = byArea[a];
    return `<tr><td>${esc(a)}</td><td>${x.n}</td><td>${x.A}</td><td>${x.M}</td><td>${x.D}</td><td>${x.R}</td><td class="pa">+${x.add}</td><td class="pd">&minus;${x.del}</td></tr>`;
  }).join('');

  const m = src.meta;
  const metaBits = [
    m.source && esc(m.source),
    m.url && `<a href="${esc(m.url)}">${esc(m.url)}</a>`,
    m.repo && `repo <code>${esc(m.repo)}</code>`,
    m.branch && `branch <code>${esc(m.branch)}</code>`,
    m.base && `base <code>${esc(m.base)}</code>`,
    m.author && `author ${esc(m.author)}`,
    `generated ${esc(new Date().toLocaleString())}`,
  ].filter(Boolean).join(' · ');

  const overview = cfg.overview ? `<ul class="ov">${(Array.isArray(cfg.overview) ? cfg.overview : [cfg.overview]).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const SEV = { risk: 'Risk', warn: 'Check', discrepancy: 'Discrepancy', info: 'Info' };
  const notes = (cfg.notes || []).map((n) => `<li class="sev-${esc(n.severity || 'info')}"><span class="sev">${esc(SEV[n.severity] || SEV.info)}</span> <b>${esc(n.title || '')}</b> ${esc(joinLines(n.text))}${G(` <label class="g ack" title="Acknowledge this note"><input type="checkbox" data-q="n-${sid((n.title || '') + '|' + joinLines(n.text))}" data-xp="${NOTE_XP[n.severity] || NOTE_XP.info}" data-cat="note" data-sub="${esc(n.severity || 'info')}"> got it</label>`)}${(n.files || []).length ? `<div class="nf">${n.files.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>` : ''}</li>`).join('');
  const diagrams = (cfg.diagrams || []).map((d, i) => `<div class="dg${d.wide ? ' wide' : ''}"${G(` data-q="d-${sid(d.title || i)}" data-xp="5" data-cat="dg"`)}><div class="dgh"><h3>${esc(d.title || `Diagram ${i + 1}`)}</h3><button class="dgx" type="button" title="Open a larger, zoomable view">⤢ Expand</button></div>${d.caption ? `<p class="cap">${esc(d.caption)}</p>` : ''}<pre class="mermaid" id="mm${i}">${esc(darkenMermaid(joinLines(d.mermaid)))}</pre></div>`).join('');
  const hls = highlights.map((h) => `<div class="hl"><h4>${esc(h.title || '')} ${h.file ? `<code>${esc(h.file)}${h.side === 'before' ? ' (before)' : ''}</code>` : ''}</h4>${h.note ? `<p class="cap">${esc(h.note)}</p>` : ''}<pre class="code">${hl(h.code, h.lang)}</pre></div>`).join('');

  const fileChip = (p) => {
    const f = files.find((x) => x.path === p);
    return `<a class="hchip" href="#${fid(p)}">${f ? badge(f.status) + ' ' : ''}<code>${esc(p)}</code>${f ? ` ${delta(f)}` : ' <i>(not in change set)</i>'}</a>`;
  };
  const hotItems = hotspots.map((h, n) => {
    const hid = `h-${sid(h.title || n)}`;
    return `<li class="hs lv-${h.level}"${G(` data-q="${hid}" data-xp="${HS_XP[h.level]}" data-cat="hs" data-lv="${h.level}"`)}><div class="hs-h"><span class="hs-n">${n + 1}</span><span class="lvl">${esc(h.level)}</span> <b>${esc(h.title || '')}</b>${clearBtn(hid)}</div>
${h.why ? `<div class="hs-why">${esc(joinLines(h.why))}</div>` : ''}
${(h.check || []).length ? `<div class="hs-ck"><span class="sev">Verify</span><ul>${[].concat(h.check).map((c, j) => `<li><label>${G(`<input type="checkbox" class="g" data-q="${hid}-c${j}" data-xp="10" data-cat="ck"> `)}${esc(c)}</label></li>`).join('')}</ul></div>` : ''}
${h.files.length ? `<div class="hs-files">${h.files.map(fileChip).join('')}</div>` : ''}
${h.snip ? `<details class="hs-code"><summary>Show code${h.side === 'before' ? ' (before)' : ''}</summary><pre class="code">${hl(h.snip.code, h.snip.lang)}</pre></details>` : ''}</li>`;
  }).join('');
  const autoItems = !cfg.hotspots && suggestions.length ? suggestions.map((s) => `<li class="hs lv-medium"${G(` data-q="h-${sid(s.path)}" data-xp="${HS_XP.medium}" data-cat="hs" data-lv="medium"`)}><div class="hs-h"><span class="lvl">score ${s.score}</span> ${fileChip(s.path)}${clearBtn(`h-${sid(s.path)}`)}</div><div class="hs-why">${esc(s.reasons.join(' · '))}</div></li>`).join('') : '';
  const hotLines = files.filter((f) => f.hot).reduce((s, f) => s + f.add + f.del, 0);
  const allLines = files.reduce((s, f) => s + f.add + f.del, 0) || 1;
  const hsCount = G(' <span class="g hs-count" id="hsCount"></span>');
  const hotSection = hotItems
    ? `<section class="tab" id="hotspots"><h2>🔥 Hotspots — read these first${hsCount}</h2><p class="cap">If you only read part of the code, read these: <b>${files.filter((f) => f.hot).length} of ${files.length} files</b>, about <b>${Math.round((100 * hotLines) / allLines)}%</b> of changed lines. Ordered by priority.</p><ol class="hotspots">${hotItems}</ol></section>`
    : autoItems
      ? `<section class="tab" id="hotspots"><h2>🔥 Hotspot candidates (auto-suggested)${hsCount}</h2><p class="cap">Heuristic only (churn, sensitive paths, risky patterns in added lines, missing test changes). Not reviewed; curate with a <code>hotspots</code> config.</p><ol class="hotspots auto">${autoItems}</ol></section>`
      : '';

  // Reading path: building-block steps where each step only relies on earlier ones.
  const byPath = new Map(files.map((f) => [f.path, f]));
  const base = (p) => p.split('/').pop();
  const pj = (p, extra = '') => {
    const f = byPath.get(p);
    return f && f.pos ? `<a class="pjump" href="#p-${f.pos}" title="${esc(p)} (${f.stepNo}.${f.inStep})">${esc(base(p))}</a>${extra}` : `<code>${esc(base(p))}</code>${extra}`;
  };
  const neededBy = new Map();
  for (const f of pathOrder) for (const u of f.uses || []) (neededBy.get(u.path) || neededBy.set(u.path, []).get(u.path)).push(f.path);
  const relList = (ps, n = 3) => ps.slice(0, n).map((p) => pj(p)).join(', ') + (ps.length > n ? ` <span class="kind">+${ps.length - n} more</span>` : '');
  const pathRow = (f) => {
    const rel = [];
    if (f.companionOf) rel.push(`companion of ${pj(f.companionOf)}`);
    if (f.uses && f.uses.length) rel.push(`builds on ${f.uses.slice(0, 4).map((u) => pj(u.path, u.syms.length ? ` <small>(${esc(u.syms.join(', '))})</small>` : '')).join(', ')}${f.uses.length > 4 ? ` <span class="kind">+${f.uses.length - 4} more</span>` : ''}`);
    const nb = neededBy.get(f.path) || [];
    if (nb.length) rel.push(`needed by ${relList(nb)}`);
    if (f.covers && f.covers.length) rel.push(`covers ${relList(f.covers)}`);
    return `<li class="pf ${f.kind}${f.hot ? ' hot' : ''}" id="p-${f.pos}" data-fi="${idxOf.get(f.path)}" data-kind="${f.kind}" data-hot="${f.hot ? 1 : 0}" data-search="${srch(f)}"><span class="pn">${f.stepNo}.${f.inStep}</span>${G(`<input type="checkbox" class="g" data-q="f-${sid(f.path)}" data-mirror title="Mark this file as reviewed">`)} ${badge(f.status)} <a class="pjump fp" href="#${diffs ? `p-${f.pos}` : fid(f.path)}" title="${diffs ? 'Show changes' : 'Open in Files'}">${esc(f.path)}</a>${f.hot ? ' <a class="hot-tag" href="#hotspots" title="Listed in Hotspots">🔥</a>' : ''} ${delta(f)}${f.desc ? `<div class="pdesc">${esc(f.desc)}</div>` : ''}${rel.length ? `<div class="prel">${rel.join(' · ')}</div>` : ''}</li>`;
  };
  const curated = rp.some((s) => s.source === 'config');
  // Split view: list on the left, the selected file's changes on the right (rendered from <template id="fv<i>">).
  const pane = (id) => `<div class="pane" id="${id}"><div class="ptool"><button data-nav="-1" title="Previous file (k)">◀</button><span class="ppos"></span><button data-nav="1" title="Next file (j)">▶</button><span class="seg" title="Toggle with f"><button data-mode="d" class="on">Changes</button><button data-mode="f">Full file</button></span><span class="seg lay" title="Toggle with s"><button data-lay="u" class="on">Unified</button><button data-lay="s">Split</button></span></div><div class="pbody"><p class="cap pempty">Select a file on the left to see its changes.</p></div></div>`;
  const split = (list, id) => (diffs ? `<div class="split"><div class="list">${list}</div><div class="gut" role="separator" aria-orientation="vertical" aria-label="Resize file list and details" tabindex="0" title="Drag to resize (double-click to reset)"></div>${pane(id)}</div>` : `<div class="list solo">${list}</div>`);
  const pathSection = pathOrder.length
    ? `<section class="tab" id="path"><h2>🧱 Reading path — building blocks${G(' <span class="g hs-count" id="pathCount"></span>')}</h2>
<p class="cap">${curated ? 'Curated reading order' : 'Auto-ordered from cross-file references: each step only relies on files from earlier steps, so you meet every type before it is used. Heuristic; curate with a <code>readingPath</code> config'}. ${rp.length} steps, ${pathOrder.length} files.${diffs ? ' Select a file to see its changes; <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>f</kbd> toggles the full file, <kbd>s</kbd> split view.' : ''}${G(' <span class="g" id="pathNext"></span>')}</p>
${split(rp.map((s) => {
    const a = s.files.reduce((t, f) => t + f.add, 0), d = s.files.reduce((t, f) => t + f.del, 0);
    return `<details class="pstep" id="step-${s.n}" data-n="${s.n}" data-t="${esc(s.title)}"${s.n === 1 || s.files.length <= 25 ? ' open' : ''}><summary><span class="sn">${s.n}</span> <b>${esc(s.title)}</b> <span class="kind">${s.files.length} file${s.files.length === 1 ? '' : 's'}</span> <span class="pa">+${a}</span> <span class="pd">&minus;${d}</span>${G('<span class="g pst"></span>')}</summary>${s.why ? `<p class="cap">${esc(s.why)}</p>` : ''}<ol class="pfiles">${s.files.map(pathRow).join('')}</ol></details>`;
  }).join('\n'), 'pane-path')}</section>`
    : '';
  const startLine = pathOrder.length > 1 ? `<p class="start">🧭 <b>Where to start:</b> ${pathOrder.slice(0, 3).map((f) => pj(f.path)).join(' → ')}${pathOrder.length > 3 ? ` → … <a href="#path">full reading path</a> <span class="kind">${rp.length} steps · ${pathOrder.length} files</span>` : ''}</p>` : '';
  // Guided walkthrough: authored narrative steps; selecting one opens its file with the anchored lines highlighted.
  const wt = walkthrough || { steps: [] };
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const paraList = (t) => (Array.isArray(t) ? t : String(t || '').split(/\n\s*\n/)).map((p) => String(p).trim()).filter(Boolean);
  const paras = (t) => paraList(t).map((p) => `<p>${md(p)}</p>`).join('');
  const copyText = (s) => [`${s.n}. ${s.title}`, ...paraList(s.text)].join('\n\n');
  const lineLbl = (s) => (s.n1 != null ? `L${s.n1}${s.n2 !== s.n1 ? `–${s.n2}` : ''}` : s.o1 != null ? `old L${s.o1}${s.o2 !== s.o1 ? `–${s.o2}` : ''}` : '');
  const walkRow = (s) => {
    const f = s.fi != null ? files[s.fi] : null;
    const rng = ['o1', 'o2', 'n1', 'n2'].filter((k) => s[k] != null).map((k) => ` data-${k}="${s[k]}"`).join('');
    const where = f ? `<div class="wfile">${badge(f.status)} <a class="pjump" href="#${diffs ? `w-${s.n}` : fid(f.path)}" title="${esc(f.path)}">${esc(base(f.path))}</a>${lineLbl(s) ? ` <span class="kind">${lineLbl(s)}</span>` : ''}</div>` : '';
    return `<li class="ws${f ? '' : ' wnote'}" id="w-${s.n}"${f && diffs ? ` data-fi="${s.fi}"${rng}` : ''}><div class="wh"><span class="sn">${s.n}</span> <b>${esc(s.title)}</b></div>${where}<div class="wtx">${paras(s.text)}</div></li>`;
  };
  const walkSection = wt.steps.length
    ? `<section class="tab" id="walk"><h2 class="wh2">🗺️ Guided walkthrough<button class="wcopy" type="button" data-copy="${esc(wt.steps.map(copyText).join('\n\n'))}" title="Copy every step's number, title and summary (no code)">⧉ Copy steps</button></h2>
<p class="cap">The story of this change in ${wt.steps.length} steps, ordered for understanding rather than by file.${diffs ? ' Select a step to see the code it talks about, highlighted; <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>f</kbd> toggles the full file, <kbd>s</kbd> split view.' : ''}</p>
${split(`${wt.intro ? `<div class="wintro">${paras(wt.intro)}</div>` : ''}<ol class="wsteps">${wt.steps.map(walkRow).join('')}</ol>${wt.outro ? `<div class="wintro wout">${paras(wt.outro)}</div>` : ''}`, 'pane-walk')}</section>`
    : '';
  const walkLine = wt.steps.length ? `<p class="start wline">🗺️ <b>New to this change?</b> <a href="#w-1">Take the guided walkthrough</a> <span class="kind">${wt.steps.length} steps · ${esc(wt.steps[0].title)} → … → ${esc(wt.steps[wt.steps.length - 1].title)}</span></p>` : '';

  const checkCount =  hotspots.reduce((s, h) => s + [].concat(h.check || []).length, 0);
  const stars = Math.min(5, 1 + [100, 400, 1000, 2500].filter((x) => allLines >= x).length + (hotspots.filter((h) => h.level === 'high').length >= 3 ? 1 : 0));
  const readMin = Math.max(1, Math.round((hotItems ? hotLines : allLines) / 25));
  const boss = hotspots.find((h) => h.level === 'high');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const questCard = G(`<div class="g quest-card">
<div><b>🎯 Quest</b> ${hotspots.length ? `Clear ${plural(hotspots.length, 'hotspot')}${checkCount ? ` and answer ${plural(checkCount, 'Verify question')}` : ''}` : `Review ${plural(files.length, 'file')}`}</div>
<div><b>Difficulty</b> <span class="stars" title="${stars} of 5">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span></div>
<div><b>⏱</b> ~${readMin} min of focused reading</div>
${boss ? `<div><b>👹 Boss</b> <a href="#hotspots">${esc(boss.title || '')}</a></div>` : ''}
<div class="cap">Progress is saved in this browser only.</div></div>`);

  const DIFF_MAX_LINES = 6000;
  const renderDiff = (f) => {
    if (f.binary) return '<p class="cap vn0">Binary file.</p>';
    let oldN = 0, newN = 0, started = false, n = 0;
    const rows = [];
    for (const l of f.diff.replace(/\n$/, '').split('\n')) {
      const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!h && !started) continue;
      if (++n > DIFF_MAX_LINES) { rows.push(`<tr class="hk"><td></td><td></td><td>… diff truncated after ${DIFF_MAX_LINES} lines; see changes.patch</td></tr>`); break; }
      if (h) { started = true; oldN = +h[1]; newN = +h[2]; rows.push(`<tr class="hk"><td></td><td></td><td>${esc(l)}</td></tr>`); continue; }
      if (l.startsWith('\\')) { rows.push(`<tr class="hk"><td></td><td></td><td>${esc(l)}</td></tr>`); continue; }
      const t = l[0], body = l.slice(1);
      if (t === '+') rows.push(`<tr class="ad"><td></td><td>${newN++}</td><td>+${hl(body, f.lang)}</td></tr>`);
      else if (t === '-') rows.push(`<tr class="dl"><td>${oldN++}</td><td></td><td>-${hl(body, f.lang)}</td></tr>`);
      else rows.push(`<tr><td>${oldN++}</td><td>${newN++}</td><td> ${hl(body, f.lang)}</td></tr>`);
    }
    return rows.length ? `<table class="diff">${rows.join('')}</table>` : `<p class="cap vn0">No content changes${f.status === 'R' ? ' (rename only)' : ''}.</p>`;
  };
  // Whole head file with the hunks woven in. Returns null if the head text does not match the diff.
  const renderFull = (f) => {
    const L = f.after.split('\n');
    if (L.length && L[L.length - 1] === '') L.pop();
    const rows = [];
    let n = 1, oldN = 1, started = false;
    const plain = (to) => { for (; n <= to && n <= L.length; n++, oldN++) rows.push(`<tr><td>${oldN}</td><td>${n}</td><td> ${hl(L[n - 1], f.lang)}</td></tr>`); };
    for (const l of f.diff.replace(/\n$/, '').split('\n')) {
      const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (h) {
        started = true;
        const ns = +h[3], nc = h[4] == null ? 1 : +h[4];
        const first = nc === 0 ? ns + 1 : ns;
        plain(first - 1);
        if (n !== first) return null;
        oldN = (h[2] === '0' ? +h[1] + 1 : +h[1]);
        continue;
      }
      if (!started || l.startsWith('\\')) continue;
      const t = l[0] || ' ', body = l.slice(1);
      if (t === '-') { rows.push(`<tr class="dl"><td>${oldN++}</td><td></td><td>-${hl(body, f.lang)}</td></tr>`); continue; }
      if (L[n - 1] !== body) return null;
      if (t === '+') rows.push(`<tr class="ad"><td></td><td>${n}</td><td>+${hl(body, f.lang)}</td></tr>`);
      else rows.push(`<tr><td>${oldN++}</td><td>${n}</td><td> ${hl(body, f.lang)}</td></tr>`);
      n++;
    }
    plain(L.length);
    return `<table class="diff full">${rows.join('')}</table>`;
  };
  const fullOf = (f) => {
    if (f.binary) return ['none', 'binary file'];
    if (f.status === 'A') return ['same', 'new file, so Changes already shows all of it'];
    if (f.status === 'D') return ['same', 'deleted file, so Changes already shows all of it'];
    const h = f.after != null ? renderFull(f) : null;
    return h ? ['yes', h] : ['none', f.fullWhy || 'the head file did not match the diff'];
  };
  const viewTpl = (f, i) => {
    const [k, v] = fullOf(f);
    const pathChip = f.pos ? ` <a class="pchip" href="#p-${f.pos}" title="Reading path step ${f.stepNo}, file ${f.inStep}">🧱 ${f.stepNo}.${f.inStep}</a>` : '';
    const box = G(` <label class="g rv" title="Mark this file as reviewed"><input type="checkbox" data-q="f-${sid(f.path)}" data-pane> reviewed</label>`);
    return `<template id="fv${i}"><div class="pv" data-full="${k}"><div class="ph">${badge(f.status)} <b class="fp">${esc(f.path)}</b>${f.oldPath ? ` <span class="kind">from ${esc(f.oldPath)}</span>` : ''} <span class="kind">${f.kind}</span>${pathChip}${f.hot ? ' <a class="hot-tag" href="#hotspots" title="Listed in Hotspots">🔥 hotspot</a>' : ''} ${delta(f)}${box}${f.desc ? `<div class="desc">${esc(f.desc)}</div>` : ''}${testList(f)}</div>${k === 'yes' ? '' : `<p class="cap vn">Full file: ${esc(v)}.</p>`}<div class="vd">${renderDiff(f)}</div>${k === 'yes' ? `<div class="vf">${v}</div>` : ''}</div></template>`;
  };
  const views = diffs ? `<div id="views" hidden>${files.map(viewTpl).join('\n')}</div>` : '';

  const tabsNav = [['summary', 'Summary'], walkSection && ['walk', '🗺️ Walkthrough', wt.steps.length], hotSection && ['hotspots', '🔥 Hotspots', hotspots.length || suggestions.length], pathSection && ['path', '🧱 Reading path', pathOrder.length], diagrams && ['diagrams', '📊 Diagrams', (cfg.diagrams || []).length], ['files', '📄 Files', files.length], hls && ['highlights', '✨ Highlights', highlights.length]].filter(Boolean);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark;--fg:#e6edf3;--mut:#8d96a0;--bd:#30363d;--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--link:#4493f8;--add:#12361f;--addt:#3fb950;--del:#4a1418;--delt:#f85149;--hk:#0c2d4f;--warn:#d29922;--purp:#a371f7;--grey:#6e7681}
*{box-sizing:border-box}body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0}
a{color:var(--link)}
header{position:sticky;top:0;z-index:5;background:var(--bg2);border-bottom:1px solid var(--bd);padding:8px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0 12px 0 0}header input[type=search]{padding:4px 8px;width:280px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg)}
header button{padding:4px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--bg3);color:var(--fg);cursor:pointer}
nav.tabs{flex-basis:100%;display:flex;gap:2px;flex-wrap:wrap;margin:0 0 -9px}nav.tabs a{padding:6px 14px;color:var(--mut);text-decoration:none;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0}
nav.tabs a:hover{color:var(--fg)}nav.tabs a.on{color:var(--fg);background:var(--bg);border-color:var(--bd);font-weight:600}nav.tabs small{font-size:11px;background:var(--bg3);border-radius:10px;padding:0 6px;margin-left:2px;color:var(--mut)}
.flt{display:flex;gap:12px;align-items:center;flex-wrap:wrap}body:not([data-tab=path]):not([data-tab=files]) .flt{display:none}
main{padding:12px 24px;max-width:1900px;margin:auto}section{margin-bottom:32px}section.tab{display:none}section.tab.on{display:block}section.tab>h2:first-child{margin-top:4px}
.split{display:grid;grid-template-columns:clamp(220px,var(--lw,max(340px,36%)),calc(100% - 372px)) 12px minmax(0,1fr);align-items:start}
.gut{align-self:stretch;position:relative;cursor:col-resize;touch-action:none;outline:none}.gut::after{content:'';position:absolute;top:0;bottom:0;left:5px;width:2px;border-radius:1px;background:var(--bd);transition:background .15s}
.gut:hover::after,.gut:focus-visible::after,body.resizing .gut::after{background:var(--link)}body.resizing{cursor:col-resize;user-select:none}
.split>.list,.split>.pane{position:sticky;top:calc(var(--hh,90px) + 8px);max-height:calc(100vh - var(--hh,90px) - 16px);overflow:auto}
.split>.list{padding-right:4px;overflow-x:hidden}.split .fp,.ph .fp{overflow-wrap:anywhere}.split .pf,.split .card{cursor:pointer}.split .pf:hover,.split .card:hover{border-color:var(--link)}
.pf.sel,.card.sel,.ws.sel{outline:2px solid var(--link);background:#1f6feb22}.ws[data-fi]{cursor:pointer}
.pane{border:1px solid var(--bd);border-radius:8px;background:var(--bg)}
.ptool{position:sticky;top:0;z-index:2;display:flex;gap:8px;align-items:center;padding:6px 10px;background:var(--bg2);border-bottom:1px solid var(--bd)}
.ptool button{padding:2px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--bg3);color:var(--fg);cursor:pointer}.ptool button:disabled{opacity:.4;cursor:default}
.ppos{font:12px monospace;color:var(--mut);min-width:60px;text-align:center}.seg{margin-left:auto;display:inline-flex}.seg button{border-radius:0}.seg button:first-child{border-radius:6px 0 0 6px}.seg button:last-child{border-radius:0 6px 6px 0;border-left:none}
.seg button.on{background:var(--link);border-color:var(--link);color:#fff}.seg.lay{margin-left:8px}
.pempty{padding:24px}.ph{padding:8px 12px;border-bottom:1px solid var(--bd);background:var(--bg2)}.ph .fp{word-break:break-all}
.vn{padding:6px 12px;font-size:12px}.vn0{padding:12px}.pane:not(.full) .vf,.pane:not(.full) .vn{display:none}.pane.full .pv[data-full=yes] .vd{display:none}
kbd{font:11px monospace;border:1px solid var(--bd);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--bg3)}
.flash{animation:pflash 1.4s ease-out}@keyframes pflash{from{background:#1f6feb66}}
@media (max-width:1000px){.split{grid-template-columns:1fr}.split>.gut{display:none}.split>.list,.split>.pane{position:static;max-height:none}.split>.list{max-height:42vh}}h2{border-bottom:1px solid var(--bd);padding-bottom:4px}
code{background:var(--bg3);border-radius:4px;padding:0 4px}pre code{background:none;padding:0}
.meta{color:var(--mut)}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{border:1px solid var(--bd);border-radius:8px;padding:8px 14px;min-width:100px;background:var(--bg2)}.stat b{font-size:22px;display:block}
table.sum{border-collapse:collapse;margin-top:12px}table.sum td,table.sum th{border:1px solid var(--bd);padding:4px 10px;text-align:left}table.sum th{background:var(--bg2)}
.b{display:inline-block;width:20px;text-align:center;border-radius:4px;font-weight:700;font-size:12px;color:#fff}.bA{background:#238636}.bM{background:#9e6a03}.bD{background:#da3633}.bR{background:#8957e5}
.pa{color:var(--addt);font-family:monospace}.pd{color:var(--delt);font-family:monospace}
.kind,.tag{font-size:11px;border:1px solid var(--bd);border-radius:10px;padding:0 6px;color:var(--mut)}.tag{background:#3b2e00;color:#e3b341;border-color:#5c4400}
.area h3 small{color:var(--mut);font-weight:normal}.card{border:1px solid var(--bd);border-left:4px solid var(--link);border-radius:6px;padding:6px 10px;margin:6px 0;background:var(--bg2)}
.card.test{border-left-color:var(--grey);background:var(--bg)}.card.build{border-left-color:var(--warn)}.card.docs{border-left-color:var(--purp)}
.fp{font-family:monospace;color:var(--link)}.desc{color:var(--mut);margin-top:2px}
.tests{font-size:12px;margin-top:4px;font-family:monospace}.ta{color:var(--addt)}.tr{color:var(--delt)}
.diagrams{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:16px}.dg{border:1px solid var(--bd);border-radius:8px;padding:10px;overflow:auto;background:var(--bg2)}.dg.wide{grid-column:1/-1}
.dg h3{margin:0 0 6px}.dgh{display:flex;align-items:flex-start;gap:8px}.dgh h3{flex:1}.dgx{display:none;flex:none;padding:2px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--bg3);color:var(--fg);cursor:pointer}.dgx:hover{border-color:var(--link)}.dg:has(pre.ok) .dgx{display:inline-block}.dg pre.ok{cursor:zoom-in}
#dgv{width:96vw;height:94vh;max-width:none;max-height:none;padding:0;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--fg);flex-direction:column}#dgv[open]{display:flex}#dgv::backdrop{background:rgba(1,4,9,.8)}
.dgvbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--bd);background:var(--bg2)}.dgvbar b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dgvbar button{padding:2px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--bg3);color:var(--fg);cursor:pointer}.dgvbar button:disabled{opacity:.4;cursor:default}.dgvbar span{font:12px monospace;color:var(--mut);min-width:48px;text-align:center}
#dgvb{flex:1;display:flex;overflow:auto;cursor:grab;user-select:none;touch-action:none}#dgvb.drag{cursor:grabbing}#dgvb svg{flex:none;margin:auto}.dgvhint{padding:4px 12px;font-size:12px;color:var(--mut);border-top:1px solid var(--bd)}.cap{color:var(--mut);margin:0 0 6px}
pre.mermaid{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:8px;border-radius:6px;margin:0}pre.mermaid.ok{background:none;white-space:normal}
pre.mermaid.merr{border:1px solid var(--delt)}.merrmsg{color:var(--delt);font-size:12px}
.notes{padding-left:0;list-style:none}.notes li{margin:8px 0;padding:6px 10px;border-left:4px solid var(--link);background:var(--bg2);border-radius:4px}
.notes li.sev-risk{border-left-color:var(--delt)}.notes li.sev-warn{border-left-color:var(--warn)}.notes li.sev-discrepancy{border-left-color:var(--purp)}
.sev{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--mut);margin-right:4px}.nf{margin-top:4px;font-size:12px}
.ov li{margin:4px 0}
.hl{border:1px solid var(--bd);border-radius:8px;margin:12px 0;background:var(--bg)}.hl h4{margin:0;padding:6px 10px;background:var(--bg2);border-bottom:1px solid var(--bd)}.hl h4 code{font-weight:normal;color:var(--mut);font-size:12px}.hl .cap{padding:6px 10px 0}
pre.code{margin:0;padding:10px;overflow:auto;font:12px/1.5 Consolas,monospace;background:var(--bg)}
.c{color:#8b949e;font-style:italic}.s{color:#a5d6ff}.k{color:#ff7b72}.t{color:#d2a8ff}.d{color:#ffa657}.n{color:#79c0ff}
table.diff{border-collapse:collapse;width:100%;font:12px/1.45 Consolas,monospace}table.diff td{padding:0 6px;vertical-align:top;white-space:pre-wrap;word-break:break-word}
table.diff:not(.sbs) td:nth-child(-n+2),table.sbs td.ln{color:var(--grey);text-align:right;width:44px;user-select:none;border-right:1px solid var(--bd)}
tr.ad{background:var(--add)}tr.dl{background:var(--del)}tr.hk td{background:var(--hk);color:var(--mut)}
table.sbs{table-layout:fixed;tab-size:4}table.sbs td:not(.ln){padding-left:calc(6px + 3ch);text-indent:-3ch}table.sbs col.cn{width:44px}table.sbs td.ad{background:var(--add)}table.sbs td.dl{background:var(--del)}table.sbs td.em{background:var(--bg2)}
table.sbs td:nth-child(2){border-right:1px solid var(--bd)}.pane.sbs table.diff:not(.sbs),.pane:not(.sbs) table.sbs{display:none}
.hidden{display:none!important}
.card.hot{box-shadow:inset 0 0 0 1px #db6d28}.card:target{outline:2px solid var(--link)}.hot-tag{font-size:11px;border:1px solid #db6d28;background:#3d1e0a;border-radius:10px;padding:0 6px;color:#ffa657;text-decoration:none}
ol.hotspots{padding-left:0;list-style:none;counter-reset:none}.hs{border:1px solid var(--bd);border-left:6px solid var(--delt);border-radius:6px;padding:8px 12px;margin:10px 0;background:var(--bg2)}
.hs.lv-medium{border-left-color:var(--warn)}.hs.lv-low{border-left-color:var(--link)}.hs-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hs-n{display:inline-flex;width:22px;height:22px;border-radius:50%;background:var(--fg);color:var(--bg);font-weight:700;font-size:12px;align-items:center;justify-content:center}
.lvl{font-size:11px;font-weight:700;text-transform:uppercase;border-radius:10px;padding:0 8px;color:#fff;background:#da3633}.lv-medium .lvl{background:#9e6a03}.lv-low .lvl{background:#1f6feb}.auto .lvl{background:var(--grey)}
.hs-why{margin:4px 0 0}.hs-ck{margin-top:4px}.hs-ck ul{margin:2px 0 0;padding-left:20px}.hs-files{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}
.hchip{border:1px solid var(--bd);border-radius:6px;padding:2px 6px;text-decoration:none;color:var(--fg);font-size:12px;background:var(--bg3)}.hchip code{color:var(--link);background:none;padding:0}
details.hs-code{margin-top:6px}details.hs-code summary{cursor:pointer;color:var(--link);font-size:12px}details.hs-code pre{border:1px solid var(--bd);border-radius:6px;background:var(--bg)}
.start{margin:10px 0;padding:8px 12px;border:1px solid var(--bd);border-left:4px solid var(--link);border-radius:6px;background:var(--bg2)}.start .pjump{font-family:monospace}
.pstep{border:1px solid var(--bd);border-radius:8px;margin:10px 0;background:var(--bg2)}.pstep>summary{cursor:pointer;padding:8px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sn{display:inline-flex;min-width:24px;height:24px;padding:0 4px;border-radius:6px;background:var(--link);color:#fff;font-weight:700;align-items:center;justify-content:center}
.pstep>.cap{padding:0 12px 0 44px}ol.pfiles{list-style:none;margin:0;padding:0 12px 10px 12px}
.pf{padding:4px 8px;margin:4px 0;border-left:3px solid var(--link);border-radius:4px;background:var(--bg)}.pf.test{border-left-color:var(--grey)}.pf.build{border-left-color:var(--warn)}.pf.docs{border-left-color:var(--purp)}.pf.hot{box-shadow:inset 0 0 0 1px #db6d28}
.pf a.fp{text-decoration:none}.pn{display:inline-block;min-width:36px;font:12px monospace;color:var(--mut)}.pf .hot-tag{padding:0 4px}
.pdesc,.prel{margin-left:40px;font-size:12px;color:var(--mut)}.prel small{color:var(--grey)}.pf:target,.pf.flash{outline:2px solid var(--link)}
.pchip{font-size:11px;border:1px solid var(--bd);border-radius:10px;padding:0 6px;text-decoration:none;color:var(--fg);background:var(--bg3);font-family:monospace}.pnext{font-size:12px;margin-left:8px;text-decoration:none}
.wline{border-left-color:var(--purp)}ol.wsteps{list-style:none;margin:0;padding:0}
.ws{margin:8px 0;padding:8px 12px;border:1px solid var(--bd);border-left:4px solid var(--purp);border-radius:8px;background:var(--bg2)}.ws.wnote{border-left-color:var(--grey)}
.ws .wh{display:flex;gap:8px;align-items:center}.ws .sn{background:var(--purp)}.wh2{display:flex;align-items:center;gap:8px}.wcopy{margin-left:auto;flex:none;padding:2px 10px;font-weight:normal;border:1px solid var(--bd);border-radius:6px;background:var(--bg3);color:var(--mut);cursor:pointer;font-size:12px}.wcopy:hover{color:var(--fg);border-color:var(--link)}.wcopy.ok{color:var(--addt);border-color:var(--addt)}.wcopy.err{color:var(--delt);border-color:var(--delt)}.wfile{margin:4px 0 0 32px;font-size:12px}.wfile .pjump{font-family:monospace}
.wtx{margin-left:32px}.wtx p{margin:6px 0}.wtx code,.wintro code{font-size:12px}.ws.flash,.ws:target{outline:2px solid var(--purp)}
.wintro{padding:6px 12px;color:var(--mut)}.wintro p{margin:6px 0}
table.diff tr.wt td{background-image:linear-gradient(#a371f726,#a371f726)}table.diff tr.wt td:first-child{box-shadow:inset 3px 0 0 var(--purp)}
${G(`body.nogame .g{display:none!important}
.hud{display:flex;align-items:center;gap:8px;margin-left:auto}.rank{font-weight:700;white-space:nowrap}
.xpbar{width:160px;height:10px;background:var(--bg3);border:1px solid var(--bd);border-radius:6px;overflow:hidden}.xpbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2da44e,#3fb950,#e3b341);transition:width .5s}
#xptxt{font:12px monospace;color:var(--mut);white-space:nowrap}.gtoggle{cursor:pointer;white-space:nowrap}
#achPanel{position:fixed;top:calc(var(--hh,52px) + 4px);right:16px;z-index:20;width:330px;max-height:70vh;overflow:auto;background:var(--bg2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;box-shadow:0 8px 24px #000a}
.ach{display:flex;gap:10px;align-items:center;padding:5px 0;opacity:.4;filter:grayscale(1)}.ach.on{opacity:1;filter:none}.ach .ai{font-size:22px}.ach small{display:block;color:var(--mut)}
.quest-card{display:flex;gap:24px;flex-wrap:wrap;align-items:center;margin:12px 0;padding:10px 14px;border:1px solid #5c4400;background:linear-gradient(90deg,#2a2000,var(--bg2));border-radius:8px}.quest-card .cap{margin:0;font-size:12px}
.stars{color:#e3b341;letter-spacing:2px}.hs-count{font-size:13px;font-weight:normal;color:var(--mut);margin-left:8px}
input[data-q]{accent-color:#3fb950;cursor:pointer;vertical-align:middle}.hs-ck label{cursor:pointer}body:not(.nogame) .hs-ck ul{list-style:none;padding-left:4px}
.hs-ck li.rv-done{color:var(--mut);text-decoration:line-through}
.gbtn{margin-left:auto;padding:2px 10px;border:1px solid var(--addt);border-radius:12px;background:transparent;color:var(--addt);cursor:pointer;font-size:12px}.gbtn:disabled{opacity:.5;cursor:not-allowed;border-color:var(--bd);color:var(--mut)}
.hs.done{border-left-color:var(--addt)}.hs.done .hs-n{background:var(--addt)}.hs.done .gbtn{background:var(--add)}
.ack,.rv{font-size:11px;color:var(--mut);margin-left:8px;cursor:pointer;white-space:nowrap}
.card.rv-done:not(.sel),.pf.rv-done:not(.sel){opacity:.6}.card.rv-done .fp::before{content:'✓ ';color:var(--addt)}.notes li.rv-done{opacity:.7}
.pf input[data-mirror]{margin:0 6px 0 0}.pf.rv-done .fp::before{content:'✓ ';color:var(--addt)}
.pst{margin-left:auto;font-size:12px;color:var(--mut)}.pstep.done{border-color:#238636}.pstep.done .sn{background:var(--addt)}
#pathNext{margin-left:6px}#pathNext a{font-family:monospace}#nextBtn{border-color:var(--link);color:var(--link)}#nextBtn:disabled{opacity:.6;cursor:default}
.xpPop{position:fixed;z-index:30;transform:translateX(-50%);font-weight:700;color:#e3b341;pointer-events:none;animation:xpup 1s ease-out forwards;text-shadow:0 1px 2px #000}
@keyframes xpup{from{margin-top:0;opacity:1}to{margin-top:-36px;opacity:0}}
#toasts{position:fixed;bottom:16px;right:16px;z-index:30;display:flex;flex-direction:column;gap:8px}
.toast{background:var(--bg2);border:1px solid #e3b341;border-radius:8px;padding:8px 14px;box-shadow:0 6px 18px #000a;animation:tin .3s ease-out;max-width:320px}.toast small{display:block;color:var(--mut)}
@keyframes tin{from{transform:translateX(40px);opacity:0}}
canvas.confetti{position:fixed;inset:0;z-index:40;pointer-events:none}
@media (prefers-reduced-motion:reduce){.xpPop,.toast{animation:none}.xpbar i{transition:none}}`)}
</style></head><body${G(` data-gk="${sid(src.patch, 12)}"`)}>
<header><h1>${esc(title)}</h1>
<span class="flt"><input type="search" id="q" placeholder="Filter files (path, description, tag)...">
<label><input type="checkbox" id="hideTests"> Hide tests</label>
${files.some((f) => f.hot) ? '<label><input type="checkbox" id="hotOnly"> Hotspots only</label>' : ''}
${G('<label class="g"><input type="checkbox" id="hideDone"> Hide reviewed</label>')}</span>
${G(`<div class="hud"><span class="g rank" id="rank"></span><span class="g xpbar" title="Review XP"><i id="xpfill"></i></span><span class="g" id="xptxt"></span>
<button class="g" id="achBtn" title="Achievements">🏆 <span id="achN">0</span>/<span id="achT">0</span></button>${pathOrder.length ? '<button class="g" id="nextBtn" title="Open the next unreviewed file in reading-path order (shortcut: n)">▶ Next</button>' : ''}<button class="g" id="reset" title="Reset review progress">↺</button>
<label class="gtoggle" title="Toggle review quest (XP and achievements)"><input type="checkbox" id="gameOn" checked> 🎮</label></div>`)}
<nav class="tabs">${tabsNav.map(([id, t, c]) => `<a href="#${id}" data-tab="${id}">${t}${c ? ` <small>${c}</small>` : ''}</a>`).join('')}</nav></header>
${G('<div id="toasts" class="g"></div><div id="achPanel" class="g hidden"></div>')}
<main>
<section class="tab" id="summary"><h2>Summary</h2>
<p class="meta">${metaBits}</p>
${overview}
${walkLine}
${startLine}
${questCard}
<div class="stats">
<div class="stat"><b>${files.length}</b>files</div><div class="stat"><b style="color:#3fb950">${tot.A}</b>added</div>
<div class="stat"><b style="color:#d29922">${tot.M}</b>modified</div><div class="stat"><b style="color:#f85149">${tot.D}</b>deleted</div>
${tot.R ? `<div class="stat"><b style="color:#a371f7">${tot.R}</b>renamed</div>` : ''}
<div class="stat"><b class="pa">+${tot.add}</b>lines added</div><div class="stat"><b class="pd">&minus;${tot.del}</b>lines removed</div>
${KIND_ORDER.filter((k) => tot[k]).map((k) => `<div class="stat"><b>${tot[k]}</b>${k} files</div>`).join('')}</div>
<table class="sum"><tr><th>Area</th><th>Files</th><th>A</th><th>M</th><th>D</th><th>R</th><th>+</th><th>&minus;</th></tr>${areaRows}</table>
${notes ? `<div id="notes"><h2>Review notes</h2><ul class="notes">${notes}</ul></div>` : ''}</section>
${walkSection}
${hotSection}
${pathSection}
${diagrams ? `<section class="tab" id="diagrams"><h2>Diagrams</h2><p class="cap" id="mstat">Rendering with mermaid (CDN). If it cannot load, diagrams are shown as readable source.</p><div class="diagrams">${diagrams}</div></section>` : ''}
<section class="tab" id="files"><h2>📄 Files</h2>${files.length ? split(fileMap, 'pane-files') : '<p>No changes.</p>'}</section>
${hls ? `<section class="tab" id="highlights"><h2>Key code highlights</h2>${hls}</section>` : ''}
</main>
${views}
${diagrams ? `<dialog id="dgv" aria-label="Diagram viewer"><div class="dgvbar"><b id="dgvt"></b><button data-z="prev" title="Previous diagram (←)">◀</button><span id="dgvpos"></span><button data-z="next" title="Next diagram (→)">▶</button><button data-z="out" title="Zoom out (−)">−</button><span id="dgvpct"></span><button data-z="in" title="Zoom in (+)">+</button><button data-z="fit" title="Fit to window (0)">Fit</button><button data-z="one" title="Actual size (1)">100%</button><button data-z="close" title="Close (Esc)">✕</button></div><div id="dgvb"></div><div class="dgvhint">Scroll to zoom · drag to pan · double-click to zoom in · ←/→ switch diagrams · 0 fit · Esc close</div></dialog><script>${DGV_JS}</script>` : ''}
<script>${APP_JS}</script>
${G(`<script>${GAME_JS}</script>`)}
<script type="module">
const pres=[...document.querySelectorAll('pre.mermaid')];const st=document.getElementById('mstat');
if(!pres.length){document.body.dataset.mermaid='none';}else{let mm;try{mm=(await import('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs')).default;mm.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark'});}catch(e){document.body.dataset.mermaid='unavailable';if(st)st.textContent='Mermaid could not be loaded (offline?) - showing diagram source.';}
if(mm){let ok=0,bad=0;for(const p of pres){const src=p.textContent;try{const {svg}=await mm.render(p.id+'svg',src);p.innerHTML=svg;p.classList.add('ok');ok++;}catch(e){bad++;p.classList.add('merr');p.textContent=src;const d=document.createElement('div');d.className='merrmsg';d.textContent='Mermaid error: '+(e&&e.message||e);p.after(d);document.getElementById('d'+p.id+'svg')?.remove();}}
document.body.dataset.mermaid=bad?'errors':'ok';document.body.dataset.mermaidOk=ok;document.body.dataset.mermaidErr=bad;if(st)st.textContent=bad?bad+' diagram(s) failed to render; source shown.':'';}}
</script>
</body></html>`;
}

try { main(); } catch (e) { console.error('ERROR ' + e.message); process.exit(1); }
