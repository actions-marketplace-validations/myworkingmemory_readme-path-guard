import { posix } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

// Parse data only: repository content never becomes HTML, a command, or a URL request.
const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const controls = /[\u0000-\u001f\u007f]/;
const blockTypes = new Set(['paragraph', 'heading', 'tableCell']);

function localTarget(destination, file) {
  if (!destination || destination.startsWith('#') || destination.startsWith('?') ||
      destination.startsWith('//') || scheme.test(destination)) return null;

  const withoutSuffix = destination.split(/[?#]/, 1)[0];
  if (!withoutSuffix) return null;
  let decoded;
  try {
    // A second decoding would misinterpret literal percent-encoded filenames.
    decoded = decodeURIComponent(withoutSuffix.replace(/%(?![\da-f]{2})/gi, '%25'));
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

function inspect(file, markdown, paths) {
  if (typeof markdown !== 'string') throw new TypeError('README content must be a string.');
  const findings = new Map();
  let checkedLinks = 0;
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map();
  const footnotes = new Map();
  const allNodes = [tree];
  while (allNodes.length) {
    const node = allNodes.pop();
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if (node.type === 'footnoteDefinition' && !footnotes.has(node.identifier)) footnotes.set(node.identifier, node);
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) allNodes.push(node.children[index]);
    }
  }

  // Definition bodies are not rendered in place. Follow only referenced
  // footnotes, once each, including references reached inside other footnotes.
  const visitedFootnotes = new Set();
  const renderedNodes = [{ node: tree, line: 1 }];
  while (renderedNodes.length) {
    const { node, line: parentLine } = renderedNodes.pop();
    if (node.type === 'definition' || node.type === 'footnoteDefinition') continue;
    const line = blockTypes.has(node.type) ? node.position.start.line : parentLine;
    if (node.type === 'footnoteReference') {
      const definition = footnotes.get(node.identifier);
      if (definition && !visitedFootnotes.has(node.identifier)) {
        visitedFootnotes.add(node.identifier);
        for (let index = definition.children.length - 1; index >= 0; index -= 1) {
          renderedNodes.push({ node: definition.children[index], line });
        }
      }
      continue;
    }
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) renderedNodes.push({ node: node.children[index], line });
    }
    let target;
    if (node.type === 'link' || node.type === 'image') target = node.url;
    else if (node.type === 'linkReference' || node.type === 'imageReference') target = definitions.get(node.identifier);
    else continue;
    const resolved = localTarget(target, file);
    if (!resolved) continue;
    checkedLinks += 1;
    if (resolved.reason || !paths.has(resolved.resolved)) {
      const reason = resolved.reason || 'missing-path';
      // This product checks file paths, not query strings or heading anchors.
      const identity = reason === 'missing-path' ? `path\0${resolved.resolved}` :
        `error\0${reason}\0${target.split(/[?#]/, 1)[0]}`;
      const previous = findings.get(identity);
      if (!previous || line < previous.line || (line === previous.line && target < previous.target)) {
        findings.set(identity, { file, line, target, resolved: resolved.resolved, reason });
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
    for (const [identity, finding] of after.findings) {
      if (!before.has(identity)) findings.push(finding);
    }
  }
  findings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 :
    a.line - b.line || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { findings, checkedReadmes, checkedLinks };
}
