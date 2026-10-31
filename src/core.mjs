import { posix } from 'node:path';
import { Parser } from 'commonmark';

// Parse data only: repository content never becomes HTML, a command, or a URL request.
const parser = new Parser();
const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const controls = /[\u0000-\u001f\u007f]/;

function localTarget(destination, file) {
  if (!destination || destination.startsWith('#') || destination.startsWith('?') ||
      destination.startsWith('//') || scheme.test(destination)) return null;

  const withoutSuffix = destination.split(/[?#]/, 1)[0];
  if (!withoutSuffix) return null;
  let decoded;
  try {
    // A second decoding would misinterpret literal percent-encoded filenames.
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    return { resolved: '', reason: 'invalid-encoding' };
  }
  if (controls.test(decoded)) return { resolved: '', reason: 'invalid-path' };

  const segments = decoded.startsWith('/') ? [] : posix.dirname(file).split('/').filter(s => s !== '.');
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return { resolved: '', reason: 'outside-repository' };
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return { resolved: segments.join('/'), reason: null };
}

function knownPaths(tree) {
  if (!Array.isArray(tree) || tree.some(path => typeof path !== 'string')) {
    throw new TypeError('Repository trees must be arrays of path strings.');
  }
  const paths = new Set(['']);
  for (const path of tree) {
    const parts = path.split('/');
    if (path.startsWith('/') || parts.some(part => part === '.' || part === '..')) {
      throw new TypeError('Tree paths must be repository-relative canonical paths.');
    }
    while (parts.length) {
      paths.add(parts.join('/'));
      parts.pop();
    }
  }
  return paths;
}

function blockLine(node) {
  // CommonMark supplies block positions, not precise inline positions.
  for (let current = node; current; current = current.parent) {
    if (current.sourcepos) return current.sourcepos[0][0];
  }
  return 1;
}

function inspect(file, markdown, paths) {
  if (typeof markdown !== 'string') throw new TypeError('README content must be a string.');
  const findings = new Map();
  let checkedLinks = 0;
  const walker = parser.parse(markdown).walker();
  let event;
  while ((event = walker.next())) {
    if (!event.entering || !['link', 'image'].includes(event.node.type)) continue;
    const target = event.node.destination;
    const resolved = localTarget(target, file);
    if (!resolved) continue;
    checkedLinks += 1;
    if (resolved.reason || !paths.has(resolved.resolved)) {
      if (!findings.has(target)) {
        findings.set(target, {
          file,
          line: blockLine(event.node),
          target,
          resolved: resolved.resolved,
          reason: resolved.reason || 'missing-path',
        });
      }
    }
  }
  return { findings, checkedLinks };
}

/**
 * Check Markdown README links against complete base/head path snapshots.
 * `baseAliases` maps a renamed head README path to its previous base path.
 * No filesystem or network access occurs. `line` is the containing Markdown
 * block's first line; anchors and external/HTML links are outside this scope.
 */
export function checkRepository({ baseFiles = {}, headFiles = {}, baseTree = [], headTree = [], baseAliases = {} } = {}) {
  const basePaths = knownPaths(baseTree);
  const headPaths = knownPaths(headTree);
  const findings = [];
  let checkedReadmes = 0;
  let checkedLinks = 0;
  for (const [file, markdown] of Object.entries(headFiles)) {
    if (file.startsWith('/') || file.split('/').some(s => !s || s === '.' || s === '..')) {
      throw new TypeError('README paths must be repository-relative canonical paths.');
    }
    const previousFile = Object.hasOwn(baseAliases, file) ? baseAliases[file] : file;
    if (typeof previousFile !== 'string' || previousFile.startsWith('/') ||
        previousFile.split('/').some(s => !s || s === '.' || s === '..')) {
      throw new TypeError('Base README aliases must be repository-relative canonical paths.');
    }
    const before = Object.hasOwn(baseFiles, previousFile) ? inspect(previousFile, baseFiles[previousFile], basePaths).findings : new Map();
    const after = inspect(file, markdown, headPaths);
    checkedReadmes += 1;
    checkedLinks += after.checkedLinks;
    for (const [target, finding] of after.findings) {
      if (!before.has(target)) findings.push(finding);
    }
  }
  findings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 :
    a.line - b.line || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { findings, checkedReadmes, checkedLinks };
}
