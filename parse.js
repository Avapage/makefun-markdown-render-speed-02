// parse(markdown) -> the HTML that marked 18.1.3 renders for the same input
// with marked's default options (gfm: true, breaks: false, pedantic: false).
//
// This is a from-scratch Markdown engine written for speed on README-shaped
// documents: block and inline lexers with first-character dispatch (marked
// tries every rule at every position; this engine only tries the rules that
// can start with the current character), marked's own rule regexes reused
// verbatim where they are already optimal (the GFM inline-text consumer),
// cached list begin-regexes, and an emphasis mask whose scans are skipped
// when their trigger characters are absent. Its grammar mirrors marked
// 18.1.3 exactly (same rules, same order of attempts, same rendering
// templates), including marked's departures from CommonMark/GFM. Anything
// the fast engine cannot complete makes it bail out, and parse() then
// delegates the whole input to the vendored marked
// (vendor/marked/marked.esm.js, MIT, see vendor/marked/LICENSE and NOTICE),
// which is the reference implementation.
//
// No state is kept between calls: each parse() lexes its input alone.

import { marked } from './vendor/marked/marked.esm.js';

class Bailout extends Error {}

export function parse(markdown) {
  if (typeof markdown !== 'string') return marked.parse(markdown);
  try {
    return fastParse(markdown);
  } catch (err) {
    if (err instanceof Bailout) return marked.parse(markdown);
    return marked.parse(markdown);
  }
}

// ---------------------------------------------------------------------------
// Small helpers (semantics mirror marked's utils)
// ---------------------------------------------------------------------------

const escapeReplacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(html, encode) {
  if (encode) {
    if (escapeTest.test(html)) return html.replace(escapeReplace, (ch) => escapeReplacements[ch]);
  } else {
    if (escapeTestNoEncode.test(html)) return html.replace(escapeReplaceNoEncode, (ch) => escapeReplacements[ch]);
  }
  return html;
}

const numericRefTest = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const numericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Decode numeric character references in a text run; escape stray `&`. */
function decodeNumericRefs(text) {
  if (!numericRefTest.test(text)) return text;
  return text.replace(numericRefOrAmp, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** marked's cleanUrl: encodeURI, with %25 folded back to %. Null on error. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Trim trailing characters equal to `ch` (marked's `trimEnd`-like helper). */
function trimEndChar(str, ch) {
  let n = str.length;
  if (n === 0) return '';
  let s = 0;
  while (s < n) {
    if (str.charAt(n - s - 1) === ch) s++;
    else break;
  }
  return str.slice(0, n - s);
}

/** Drop trailing blank lines beyond the first (marked's html/code raw trim). */
const blankLineRe = /^[ \t]*$/;
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && blankLineRe.test(lines[t])) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

/** Link label normalisation: trim, collapse whitespace, case-fold. */
function normalizeLabel(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the first unescaped closing bracket that unbalances, etc. */
function findUnbalanced(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < str.length; n++) {
    if (str[n] === '\\') n++;
    else if (str[n] === pair[0]) depth++;
    else if (str[n] === pair[1] && --depth < 0) return n;
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs in `str` with tab stops of 4, starting at column `offset`. */
function expandTabs(str, offset = 0) {
  let col = offset;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule construction. marked builds its big regexes by substituting named
// sub-patterns into templates; doing the same here keeps the resulting
// expressions identical by construction.
// ---------------------------------------------------------------------------

function edit(regex, flags = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const api = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, v);
      return api;
    },
    getRegex() {
      return new RegExp(source, flags);
    },
  };
  return api;
}

const blockTags =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const inlineAttribute = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;

const R = {
  // -- other (marked's `other` table) --
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
};

// -- block rules (gfm set) --
const blockNewline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const blockFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const blockHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/;
const blockHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullPattern = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const blockList = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bullPattern).getRegex();

const blockHtml = edit(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))',
  'i',
)
  .replace('comment', htmlComment)
  .replace('tag', blockTags)
  .replace('attribute', inlineAttribute)
  .getRegex();

const labelPattern = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const blockDef = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', labelPattern)
  .replace('title', /(?:\"(?:\\[\s\S]|[^\"])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const blockTable = edit(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', blockTags)
  .getRegex();

// marked's lheading template (Oe) with its substitutions; gfm uses the Ge
// variant (table alternative present in the lookahead), normal uses `we`.
const lheadingTemplate =
  "^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)";
function buildLheading(withTable) {
  let e = edit(lheadingTemplate)
    .replace(/bull/g, bullPattern)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/);
  e = withTable ? e.replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/) : e.replace(/\|table/g, '');
  return e.getRegex();
}
const blockLheading = buildLheading(true); // gfm variant (Ge)

const paragraphBase = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const paragraphHtmlStart =
  ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const paragraphFences = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
// marked builds three paragraph variants from the same template (its `Pe`
// helper): the plain one, the blockquote-internal one (Ke), and — with the
// table alternative kept and a `1.`-only list interruption — the gfm one.
function buildParagraph(listPattern, keepTable) {
  let e = edit(paragraphBase)
    .replace('hr', blockHr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  e = keepTable ? e.replace('table', blockTable) : e.replace('|table', '');
  return e
    .replace('blockquote', ' {0,3}>')
    .replace('fences', paragraphFences)
    .replace('list', listPattern)
    .replace('html', paragraphHtmlStart)
    .replace('tag', blockTags)
    .getRegex();
}
const blockParagraph = buildParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', true);
const blockquoteParagraph = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, false);

const blockText = /^[^\n]+/;

const blockBlockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

// -- inline rules (gfm set) --
const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const bracketPair = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const linkLabel = edit(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .replace('brackets', bracketPair)
  .getRegex();
const inlineLink = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', linkLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const inlineReflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', linkLabel)
  .replace('ref', labelPattern)
  .getRegex();
const inlineNolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', labelPattern)
  .getRegex();
const maskLabel = edit(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .replace('brackets', bracketPair)
  .getRegex();
const maskRef = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const inlineReflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    edit(/^!?\[(label)\]\[(ref)\]/).replace('label', maskLabel).replace('ref', maskRef).getRegex(),
  )
  .replace(
    'nolink',
    edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', maskRef).getRegex(),
  )
  .getRegex();
const inlineBlockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const punctClass = '[\\p{P}\\p{S}]';
const punctNoTilde = '(?!~)[\\p{P}\\p{S}]';
const punctSpaceClass = '[\\s\\p{P}\\p{S}]';
const punctSpaceNoTilde = '(?!~)[\\s\\p{P}\\p{S}]';
const notPunctSpaceClass = '[^\\s\\p{P}\\p{S}]';
const notPunctSpaceOrTilde = '(?:[^\\s\\p{P}\\p{S}]|~)';
const emStrongLDelim = edit(
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  'u',
)
  .replace(/punct/g, punctNoTilde)
  .getRegex();
const emStrongRDelimAst = edit(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",
  'gu',
)
  .replace(/notPunctSpace/g, notPunctSpaceOrTilde)
  .replace(/punctSpace/g, punctSpaceNoTilde)
  .replace(/punct/g, punctNoTilde)
  .getRegex();
const emStrongRDelimUnd = edit(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
  'gu',
)
  .replace(/notPunctSpace/g, notPunctSpaceClass)
  .replace(/punctSpace/g, punctSpaceClass)
  .replace(/punct/g, punctClass)
  .getRegex();
const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, punctClass)
  .getRegex();
const delRDelim = edit(
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
  'gu',
)
  .replace(/notPunctSpace/g, notPunctSpaceClass)
  .replace(/punctSpace/g, punctSpaceClass)
  .replace(/punct/g, punctClass)
  .getRegex();
const inlinePunctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, punctSpaceClass)
  .getRegex();
const inlineAnyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, punctClass)
  .getRegex();
const inlineAnyPunctuationOutsideCode = edit(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu',
)
  .replace(/punct/g, punctClass)
  .getRegex();
const inlineComment = edit(htmlComment).replace('(?:-->|$)', '-->').getRegex();
const tagAttribute = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
const inlineTag = edit(
  "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
)
  .replace('comment', inlineComment)
  .replace('attribute', tagAttribute)
  .getRegex();
const inlineAutolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .getRegex();
const urlEmail = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const emailProtocolFull = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const inlineUrl = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', emailProtocolFull)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace('email', urlEmail)
  .getRegex();
const inlineBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const inlineText = new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))");

// Shared tokeniser helpers
// ---------------------------------------------------------------------------

/** Split a table row on unescaped pipes (marked's cell splitter). */
function splitTableRow(row, count) {
  const replaced = row.replace(R.findPipe, (match, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = replaced.split(R.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

/** Fenced-code indent compensation: strip the fence's indent from content. */
function fenceText(raw, text) {
  const m = raw.match(R.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const s = line.match(R.beginningSpace);
      if (s === null) return line;
      return line.slice(Math.min(s[0].length, indent.length));
    })
    .join('\n');
}

/**
 * For each of `*`, `_`, `~`: the start index of the last delimiter run whose
 * preceding character is not blank — the last possible closer position used
 * to bound emphasis/strikethrough matching.
 */
function lastCloserIndexes(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Per-indent begin-of-line regexes for the list tokeniser. marked clamps the
// effective indent via min(max(indent - 1, 0), 3) and caches per factory;
// the same clamp and caching are applied here.
const beginCache = new Map();
function beginRegex(kind, indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  const key = kind + ':' + n;
  let re = beginCache.get(key);
  if (re) return re;
  switch (kind) {
    case 'bullet':
      re = new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
      break;
    case 'hr':
      re = new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
      break;
    case 'fences':
      re = new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
      break;
    case 'heading':
      re = new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
      break;
    case 'html':
      re = new RegExp(
        `^ {0,${n}}(?:</?(?:${blockTags})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      );
      break;
    default: // 'blockquote'
      re = new RegExp(`^ {0,${n}}>`);
  }
  beginCache.set(key, re);
  return re;
}
const listItemCache = new Map();
function listItemRegex(bull) {
  let re = listItemCache.get(bull);
  if (!re) {
    re = new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
    listItemCache.set(bull, re);
  }
  return re;
}

/**
 * Guard used by the link tokenisers: true when the label contains an inline
 * tag or autolink that would extend past the label's end.
 */
function linkGuard(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = inlineCode.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const m = inlineTag.exec(rest) || inlineAutolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lexer: block lexing first (queuing inline work), then inline lexing, in
// the same order and with the same token merging as marked.
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    const tokens = [];
    this.blockTokens(src, tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return tokens;
  }

  inline(text, tokens = []) {
    this.inlineQueue.push({ src: text, tokens });
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineTokensInner(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  // -- block dispatch -------------------------------------------------------
  blockTokens(src, tokens = [], canMergeParagraph = false) {
    let guard = Infinity;
    let e = src;
    while (e) {
      if (e.length < guard) guard = e.length;
      else throw new Bailout('block loop made no progress');
      let tok;
      if ((tok = this.tokSpace(e))) {
        e = e.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokCode(e))) {
        e = e.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokFences(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHeading(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHr(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokBlockquote(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokList(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHtml(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokDef(e))) {
        e = e.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          if (!Object.hasOwn(this.links, tok.tag)) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokLheading(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokParagraph(e))) {
        const last = tokens[tokens.length - 1];
        if (canMergeParagraph && last && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        canMergeParagraph = false;
        e = e.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(e))) {
        e = e.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Bailout('no block tokeniser matched');
    }
    this.state.top = true;
    return tokens;
  }

  // -- block tokenisers -----------------------------------------------------
  tokSpace(src) {
    const cap = blockNewline.exec(src);
    if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
    return undefined;
  }

  tokCode(src) {
    const cap = blockCode.exec(src);
    if (!cap) return undefined;
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(R.codeRemoveIndent, '') };
  }

  tokFences(src) {
    const cap = blockFences.exec(src);
    if (!cap) return undefined;
    return {
      type: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(inlineAnyPunctuation, '$1') : cap[2],
      text: fenceText(cap[0], cap[3] || ''),
    };
  }

  tokHeading(src) {
    const cap = blockHeading.exec(src);
    if (!cap) return undefined;
    let text = cap[2].trim();
    if (R.endingHash.test(text)) {
      const stripped = trimEndChar(text, '#');
      if (!stripped || R.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: trimEndChar(cap[0], '\n'), depth: cap[1].length, text, tokens: this.inline(text) };
  }

  tokHr(src) {
    const cap = blockHr.exec(src);
    if (cap) return { type: 'hr', raw: trimEndChar(cap[0], '\n') };
    return undefined;
  }

  tokBlockquote(src) {
    const cap = blockBlockquote.exec(src);
    if (!cap) return undefined;
    let rest = trimEndChar(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (rest.length > 0) {
      let seenQuote = false;
      const chunk = [];
      let p = 0;
      for (; p < rest.length; p++) {
        if (R.blockquoteStart.test(rest[p])) {
          chunk.push(rest[p]);
          seenQuote = true;
        } else if (!seenQuote) chunk.push(rest[p]);
        else break;
      }
      rest = rest.slice(p);
      const chunkRaw = chunk.join('\n');
      const chunkText = chunkRaw
        .replace(R.blockquoteMarkerWhitespace, (m, b, ws) => b + expandTabs(ws, b.length))
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n' + chunkText : chunkText;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(chunkText, tokens, true);
      this.state.top = savedTop;
      if (rest.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        const mergedSrc = last.raw + '\n' + rest.join('\n').replace(R.blockquoteSetextReplace2, '');
        const merged = this.tokBlockquote(mergedSrc);
        if (!merged) throw new Bailout('blockquote re-lex failed');
        tokens[tokens.length - 1] = merged;
        const leftover = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? rest.slice(0, -leftoverCount) : rest;
        if (consumed.length > 0) raw += '\n' + consumed.join('\n');
        text = text.substring(0, text.length - last.text.length) + merged.text;
        rest = rest.slice(consumed.length);
        if (rest.length > 0 && R.blockquoteStart.test(rest[0])) continue;
        break;
      }
      if (last && last.type === 'list') {
        const joined = last.raw + '\n' + rest.join('\n');
        const merged = this.tokList(joined);
        if (!merged) throw new Bailout('list re-lex failed');
        tokens[tokens.length - 1] = merged;
        const extra =
          merged.raw.length > last.raw.length
            ? joined.slice(last.raw.length + 1, merged.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const taken = rest.slice(0, extra).join('\n');
          raw += '\n' + taken;
          text += '\n' + taken;
        }
        rest = rest.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  tokList(src) {
    const cap = blockList.exec(src);
    if (!cap) return undefined;
    const fullSrc = src;
    const bullet = cap[1].trim();
    const ordered = bullet.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bullPattern = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRegex(bullPattern);
    let prevItemBlank = false;
    let rest = src;
    while (rest) {
      let itemBlank = false;
      let itemText = '';
      const m = itemRe.exec(rest);
      if (!m || blockHr.test(rest)) break;
      const startLen = fullSrc.length - rest.length;
      rest = rest.substring(m[0].length);
      const firstContent = m[2].split('\n', 1)[0];
      const bulletLen = m[1].length;
      const content = firstContent.replace(R.leadingSpaceTab, (v) => expandTabs(v, bulletLen));
      const nextLine = rest.split('\n', 1)[0];
      const blankContent = !content.trim();
      let indent = 0;
      if (blankContent) {
        indent = bulletLen + 1;
      } else {
        indent = content.search(R.nonSpaceChar);
        if (indent > 4) indent = 1;
        itemText = content.slice(indent);
        indent += bulletLen;
      }
      if (blankContent && R.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        itemBlank = true;
      }
      if (!itemBlank) {
        const nextBulletRe = beginRegex('bullet', indent);
        const hrRe = beginRegex('hr', indent);
        const fencesRe = beginRegex('fences', indent);
        const headingRe = beginRegex('heading', indent);
        const htmlRe = beginRegex('html', indent);
        const quoteRe = beginRegex('blockquote', indent);
        let prevContent = content;
        let isBlank = blankContent;
        while (rest) {
          const line = rest.split('\n', 1)[0];
          const expanded = line.replace(R.leadingSpaceTab, (v) => expandTabs(v));
          if (
            fencesRe.test(line) ||
            headingRe.test(line) ||
            htmlRe.test(line) ||
            quoteRe.test(line) ||
            nextBulletRe.test(line) ||
            hrRe.test(line)
          ) {
            break;
          }
          if (expanded.search(R.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (
              isBlank ||
              prevContent.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >= 4 ||
              fencesRe.test(prevContent) ||
              headingRe.test(prevContent) ||
              htmlRe.test(prevContent) ||
              hrRe.test(prevContent)
            ) {
              break;
            }
            const lazy =
              /^ {0,3}(?:=+|-+) *$/.test(line) && blockLheading.test(prevContent + '\n' + line)
                ? '    ' + expanded.replace(/^ {0,3}/, '')
                : line;
            itemText += '\n' + lazy;
          }
          isBlank = !line.trim();
          rest = rest.substring(line.length + 1);
          prevContent = expanded.slice(indent);
        }
      }
      const itemRaw = fullSrc.slice(startLen, fullSrc.length - rest.length);
      if (!list.loose) {
        if (prevItemBlank) list.loose = true;
        else if (R.doubleBlankLine.test(itemRaw)) prevItemBlank = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: R.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = fullSrc.slice(0, fullSrc.length - rest.length).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        list.loose = spaces.length > 0 && spaces.some((t) => R.anyLine.test(t.raw));
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        first.raw = first.raw.replace(R.listReplaceTask, '');
        first.text = first.text.replace(R.listReplaceTask, '');
        for (let g = this.inlineQueue.length - 1; g >= 0; g--) {
          if (R.listIsTask.test(this.inlineQueue[g].src)) {
            this.inlineQueue[g].src = this.inlineQueue[g].src.replace(R.listReplaceTask, '');
            break;
          }
        }
        const checkboxMatch = R.listTaskCheckbox.exec(item.raw);
        if (checkboxMatch) {
          const checkbox = { type: 'checkbox', raw: checkboxMatch[0] + ' ', checked: checkboxMatch[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            const head = item.tokens[0];
            if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
              head.raw = checkbox.raw + head.raw;
              head.text = checkbox.raw + head.text;
              head.tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  tokHtml(src) {
    const cap = blockHtml.exec(src);
    if (!cap) return undefined;
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }

  tokDef(src) {
    const cap = blockDef.exec(src);
    if (!cap) return undefined;
    if (!R.startAngleBracket.test(cap[2]) && findUnbalanced(cap[2], '()') !== -1) return undefined;
    return {
      type: 'def',
      tag: normalizeLabel(cap[1]),
      raw: trimEndChar(cap[0], '\n'),
      href: cap[2] ? cap[2].replace(R.hrefBrackets, '$1').replace(inlineAnyPunctuation, '$1') : '',
      title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inlineAnyPunctuation, '$1') : cap[3],
    };
  }

  tokTable(src) {
    const cap = blockTable.exec(src);
    if (!cap || !R.tableDelimiter.test(cap[2])) return undefined;
    const headerCells = splitTableRow(cap[1]);
    const alignRow = cap[2].replace(R.tableAlignChars, '').split('|');
    if (headerCells.length !== alignRow.length) return undefined;
    const table = { type: 'table', raw: trimEndChar(cap[0], '\n'), header: [], align: [], rows: [] };
    for (const cell of alignRow) {
      table.align.push(
        R.tableAlignRight.test(cell) ? 'right' : R.tableAlignCenter.test(cell) ? 'center' : R.tableAlignLeft.test(cell) ? 'left' : null,
      );
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], tokens: this.inline(headerCells[i]), header: true, align: table.align[i] });
    }
    const rowsRaw = cap[3]?.trim() ? cap[3].replace(R.tableRowBlankLine, '').split('\n') : [];
    for (const rowLine of rowsRaw) {
      table.rows.push(
        splitTableRow(rowLine, table.header.length).map((cell, j) => ({
          text: cell,
          tokens: this.inline(cell),
          header: false,
          align: table.align[j],
        })),
      );
    }
    return table;
  }

  tokLheading(src) {
    const cap = blockLheading.exec(src);
    if (!cap) return undefined;
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: trimEndChar(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.inline(text),
    };
  }

  tokParagraph(src) {
    const cap = blockParagraph.exec(src);
    if (!cap) return undefined;
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: this.inline(text) };
  }

  tokText(src) {
    const cap = blockText.exec(src);
    if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: this.inline(cap[0]) };
    return undefined;
  }

  // -- inline lexing ----------------------------------------------------------
  maskSrc(src) {
    let masked = src;
    if (src.includes('[')) {
      const maskLink = (match) => {
        const o = match.lastIndexOf('[');
        if (!Object.hasOwn(this.links, normalizeLabel(match.slice(o + 1, -1)))) return match;
        if (o > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, o - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(inlineReflinkSearch, maskLink) + '][' + 'a'.repeat(match.length - o - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      masked = masked.replace(inlineReflinkSearch, maskLink);
    }
    // Each replace is a no-op when its trigger characters are absent:
    // anyPunctuationOutsideCode can only match a backtick run or a backslash
    // escape; blockSkip can only match a link '[', a code span '`' or a tag
    // '<'. Skipping the scan preserves the result exactly.
    if (src.includes('`') || src.includes('\\')) {
      masked = masked.replace(inlineAnyPunctuationOutsideCode, (match, g1, g2) =>
        g2
          ? '+'.repeat(match.length)
          : g1
            ? g1 + match.slice(g1.length, -g1.length).replace(/`/g, '+') + g1
            : match,
      );
    }
    if (src.includes('[') || src.includes('`') || src.includes('<')) {
      masked = masked.replace(inlineBlockSkip, (match, g1, g2) => {
        const o = g2 ? g2.length : 0;
        return match.slice(0, o) + '[' + 'a'.repeat(match.length - o - 2) + ']';
      });
    }
    return masked;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(inlineBlockSkip)) {
      if (inlineLink.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(inlineReflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (
        !(s.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && this.linkInText(s.slice(1, r - 1)))
      ) {
        return true;
      }
    }
    return false;
  }

  outputLink(cap, link, raw) {
    const href = link.href;
    const title = link.title || null;
    const label = cap[1].replace(R.outputLinkReplace, '$1');
    const isImage = cap[0].charAt(0) === '!';
    const prevInLink = this.state.inLink;
    const prevEmitted = this.state.linkEmitted;
    const prevRawBlock = this.state.inRawBlock;
    this.state.inLink = true;
    this.state.linkEmitted = false;
    const tokens = this.inlineTokens(label);
    const emitted = this.state.linkEmitted;
    this.state.linkEmitted = prevEmitted;
    this.state.inLink = prevInLink;
    if (!isImage) {
      if (emitted) {
        this.state.inRawBlock = prevRawBlock;
        return undefined;
      }
      this.state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text: label, tokens };
  }

  inlineTokensInner(src, tokens) {
    let masked = src;
    if (src.includes('*') || src.includes('_') || src.includes('~')) masked = this.maskSrc(src);
    const fe = lastCloserIndexes(masked);
    let e = src;
    let prevChar = '';
    let prevWasText = false;
    let guard = Infinity;
    while (e) {
      if (e.length < guard) guard = e.length;
      else throw new Bailout('inline loop made no progress');
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      let tok;
      const c0 = e.charCodeAt(0);
      if (c0 === 92 && (tok = this.tokEscape(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 60 && (tok = this.tokTag(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((c0 === 91 || c0 === 33) && (tok = this.tokLink(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((c0 === 91 || c0 === 33) && (tok = this.tokReflink(e))) {
        e = e.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((c0 === 42 || c0 === 95) && (tok = this.tokEmStrong(e, masked, fe, prevChar))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 96 && (tok = this.tokCodespan(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((c0 === 32 || c0 === 92) && (tok = this.tokBr(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 126 && (tok = this.tokDel(e, masked, fe, prevChar))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 60 && (tok = this.tokAutolink(e))) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (
        !this.state.inLink &&
        (isAlnumCode(c0) || c0 === 46 || c0 === 43 || c0 === 45 || c0 === 95) &&
        (tok = this.tokUrl(e))
      ) {
        e = e.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      tok = this.tokInlineText(e);
      e = e.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      prevWasText = true;
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else tokens.push(tok);
    }
    return tokens;
  }

  // -- inline tokenisers ------------------------------------------------------
  tokEscape(src) {
    const cap = inlineEscape.exec(src);
    if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
    return undefined;
  }

  tokTag(src) {
    const cap = inlineTag.exec(src);
    if (!cap) return undefined;
    if (!this.state.inLink && R.startATag.test(cap[0])) this.state.inLink = true;
    else if (this.state.inLink && R.endATag.test(cap[0])) this.state.inLink = false;
    if (!this.state.inRawBlock && R.startPreScriptTag.test(cap[0])) this.state.inRawBlock = true;
    else if (this.state.inRawBlock && R.endPreScriptTag.test(cap[0])) this.state.inRawBlock = false;
    return {
      type: 'html',
      raw: cap[0],
      inLink: this.state.inLink,
      inRawBlock: this.state.inRawBlock,
      block: false,
      text: cap[0],
    };
  }

  tokLink(src) {
    if (this.state.linkParenPossible === false) return undefined;
    const cap = inlineLink.exec(src);
    if (!cap) return undefined;
    const offset = cap[0].charAt(0) === '!' ? 2 : 1;
    if (linkGuard(src, cap[1], offset)) return undefined;
    const hrefTrimmed = cap[2].trim();
    if (R.startAngleBracket.test(hrefTrimmed)) {
      if (!R.endAngleBracket.test(hrefTrimmed)) return undefined;
      const inner = trimEndChar(hrefTrimmed.slice(0, -1), '\\');
      if ((hrefTrimmed.length - inner.length) % 2 === 0) return undefined;
    } else {
      const l = findUnbalanced(cap[2], '()');
      if (l === -2) return undefined;
      if (l > -1) {
        const start = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + l;
        cap[2] = cap[2].substring(0, l);
        cap[0] = cap[0].substring(0, start).trim();
        cap[3] = '';
      }
    }
    const rawInner = trimEndChar(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - rawInner.length) % 2 === 0) return undefined;
    let href = cap[2].trim();
    if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    return this.outputLink(
      cap,
      {
        href: href && href.replace(inlineAnyPunctuation, '$1'),
        title: title && title.replace(inlineAnyPunctuation, '$1'),
      },
      cap[0],
    );
  }

  tokReflink(src) {
    let cap;
    if ((cap = inlineReflink.exec(src)) || (cap = inlineNolink.exec(src))) {
      const offset = cap[0].charAt(0) === '!' ? 2 : 1;
      if (linkGuard(src, cap[1], offset)) return undefined;
      const link = this.links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const firstChar = cap[0].charAt(0);
        return { type: 'text', raw: firstChar, text: firstChar };
      }
      return this.outputLink(cap, link, cap[0]);
    }
    return undefined;
  }

  tokEmStrong(src, masked, fe, prevChar) {
    const cap = emStrongLDelim.exec(src);
    if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
    const delimChar = cap[0][0];
    const prevCharIsDelimiter = prevChar === delimChar;
    const maskPos = masked.length - src.length;
    let runStart = maskPos;
    while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
    const beforeRun = masked.slice(Math.max(0, runStart - 2), runStart);
    const prevPrevChar = [...beforeRun].at(-1) ?? '';
    const prevPrevIsPunct =
      prevPrevChar === '*' || prevPrevChar === '_' || inlinePunctuation.test(prevPrevChar);
    if (runStart < maskPos) prevChar = prevPrevChar;
    const prevCharIsPunct = runStart < maskPos ? prevPrevIsPunct : inlinePunctuation.test(prevChar);
    if (cap[4] && R.unicodeAlphaNumeric.test(prevChar)) return undefined;
    const punctGroup = cap[1] || cap[3] || '';
    if (!punctGroup || !prevChar || prevCharIsPunct) {
      const delimCount = [...cap[0]].length - 1;
      let remaining = delimCount;
      let unusedCloser = 0;
      const totalRun = maskPos - runStart + delimCount;
      const midWord = !!prevPrevChar.trim() && (!!punctGroup || (delimChar === '*' && !prevPrevIsPunct));
      const rDelim = delimChar === '*' ? emStrongRDelimAst : emStrongRDelimUnd;
      const lastIdx = fe.em[delimChar];
      const startIdx = maskPos + delimCount;
      if (lastIdx < startIdx) return undefined;
      const rest = masked.slice(-src.length + delimCount);
      const maxCloserOffset = lastIdx - startIdx;
      rDelim.lastIndex = 0;
      let m;
      while ((m = rDelim.exec(rest)) !== null && !(m.index > maxCloserOffset)) {
        const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        let b = [...g].length;
        if (m[3] || m[4]) {
          remaining += b;
          continue;
        }
        if (m[5] || m[6] || midWord) {
          if (prevCharIsDelimiter && (m[5] || m[6])) break;
          if (totalRun % 3 && !((totalRun + b) % 3)) {
            unusedCloser += b;
            continue;
          }
        }
        remaining -= b;
        if (remaining > 0) continue;
        b = Math.min(b, b + remaining + unusedCloser);
        const firstCharLen = [...m[0]][0].length;
        const raw = src.slice(0, delimCount + m.index + firstCharLen + b);
        if (Math.min(delimCount, b) % 2) {
          const text = raw.slice(1, -1);
          return { type: 'em', raw, text, tokens: this.inlineTokens(text) };
        }
        const text = raw.slice(2, -2);
        return { type: 'strong', raw, text, tokens: this.inlineTokens(text) };
      }
    }
    return undefined;
  }

  tokCodespan(src) {
    const cap = inlineCode.exec(src);
    if (!cap) return undefined;
    let text = cap[2].replace(/\n/g, ' ');
    const hasNonSpace = R.nonSpaceChar.test(text);
    const endsWithSpace = R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
    if (hasNonSpace && endsWithSpace) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }

  tokBr(src) {
    const cap = inlineBr.exec(src);
    if (cap) return { type: 'br', raw: cap[0] };
    return undefined;
  }

  tokDel(src, masked, fe, prevChar) {
    const cap = delLDelim.exec(src);
    if (!cap) return undefined;
    if (!cap[1] || !prevChar || inlinePunctuation.test(prevChar)) {
      const delimLen = [...cap[0]].length - 1;
      let remaining = delimLen;
      const lastIdx = fe.del;
      const startIdx = masked.length - src.length + delimLen;
      if (lastIdx < startIdx) return undefined;
      const rest = masked.slice(-src.length + delimLen);
      const maxOffset = lastIdx - startIdx;
      delRDelim.lastIndex = 0;
      let m;
      while ((m = delRDelim.exec(rest)) !== null && !(m.index > maxOffset)) {
        const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        let len = [...g].length;
        if (len !== delimLen) continue;
        if (m[3] || m[4]) {
          remaining += len;
          continue;
        }
        remaining -= len;
        if (remaining > 0) continue;
        len = Math.min(len, len + remaining);
        const firstCharLen = [...m[0]][0].length;
        const raw = src.slice(0, delimLen + m.index + firstCharLen + len);
        const text = raw.slice(delimLen, -delimLen);
        return { type: 'del', raw, text, tokens: this.inlineTokens(text) };
      }
    }
    return undefined;
  }

  tokAutolink(src) {
    const cap = inlineAutolink.exec(src);
    if (!cap) return undefined;
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  tokUrl(src) {
    const cap = inlineUrl.exec(src);
    if (!cap) return undefined;
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = cap[0];
        cap[0] = inlineBackpedal.exec(cap[0])?.[0] ?? '';
      } while (prev !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  tokInlineText(src) {
    const raw = inlineText.exec(src)[0];
    const inRaw = this.state.inRawBlock;
    return { type: 'text', raw, text: inRaw ? raw : decodeNumericRefs(raw), escaped: inRaw };
  }
}

// ---------------------------------------------------------------------------
// Renderer: marked's default rendering templates, block and inline, plus
// its plain-text renderer used for image alt text.
// ---------------------------------------------------------------------------

function renderTextToken(token) {
  if (token.tokens) return renderInline(token.tokens, false);
  if (token.escaped) return token.text;
  return escapeHtml(token.text);
}

function renderCodeBlock(token) {
  const langName = (token.lang || '').match(/^\S*/)?.[0];
  const text = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
  const body = token.escaped ? text : escapeHtml(text, true);
  return langName
    ? `<pre><code class="language-${escapeHtml(langName)}">${body}</code></pre>\n`
    : `<pre><code>${body}</code></pre>\n`;
}

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + renderInline(cell.tokens, false) + `</${tag}>\n`;
}

function renderTable(token) {
  let headerHtml = '';
  for (const cell of token.header) headerHtml += renderTableCell(cell);
  let out = `<table>\n<thead>\n<tr>\n${headerHtml}</tr>\n</thead>\n`;
  let body = '';
  for (const row of token.rows) {
    let rowHtml = '';
    for (const cell of row) rowHtml += renderTableCell(cell);
    body += `<tr>\n${rowHtml}</tr>\n`;
  }
  if (body) out += `<tbody>${body}</tbody>`;
  return out + '</table>\n';
}

function renderList(token) {
  let items = '';
  for (const item of token.items) items += `<li>${renderTokens(item.tokens)}</li>\n`;
  const tag = token.ordered ? 'ol' : 'ul';
  const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function renderLink(token) {
  const inner = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens, false);
  const cleaned = cleanUrl(token.href);
  if (cleaned === null) return inner;
  let out = `<a href="${escapeHtml(cleaned, token.autolink)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  return out + '>' + inner + '</a>';
}

function renderImage(token) {
  const alt = token.tokens ? renderInline(token.tokens, true) : token.text;
  const cleaned = cleanUrl(token.href);
  if (cleaned === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(cleaned)}" alt="${escapeHtml(alt)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  return out + '>';
}

function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInline(token.tokens, false)}</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCodeBlock(token);
        break;
      case 'table':
        out += renderTable(token);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(token.tokens)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(token);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += `<p>${renderInline(token.tokens, false)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(token);
        break;
      default:
        throw new Bailout('unknown block token ' + token.type);
    }
  }
  return out;
}

function renderInline(tokens, plain) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += plain ? token.text : escapeHtml(token.text);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link':
        out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : renderLink(token);
        break;
      case 'image':
        out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : renderImage(token);
        break;
      case 'checkbox':
        out += plain ? token.raw : renderCheckbox(token);
        break;
      case 'strong':
        out += plain ? renderInline(token.tokens, true) : `<strong>${renderInline(token.tokens, false)}</strong>`;
        break;
      case 'em':
        out += plain ? renderInline(token.tokens, true) : `<em>${renderInline(token.tokens, false)}</em>`;
        break;
      case 'codespan':
        out += plain ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain ? renderInline(token.tokens, true) : `<del>${renderInline(token.tokens, false)}</del>`;
        break;
      case 'text':
        out += plain ? token.text : renderTextToken(token);
        break;
      default:
        throw new Bailout('unknown inline token ' + token.type);
    }
  }
  return out;
}

function fastParse(src) {
  const lexer = new Lexer();
  const tokens = lexer.lex(src);
  return renderTokens(tokens);
}
