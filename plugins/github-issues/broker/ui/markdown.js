/* Safe GitHub-Flavored-Markdown renderer for the GitHub Issues plugin UI
 * (issue #1642, Item 3).
 *
 * The issue body is UNTRUSTED GitHub content. The console renders Markdown with
 * react-markdown + remark-gfm + rehype-sanitize (sanitize last), but this plugin
 * UI is a dependency-free vanilla-JS iframe served from the broker origin with no
 * build step — it cannot bundle that React pipeline. Per the ticket's own
 * implementation note, "reuse" here means adopting the same APPROACH and safety,
 * not importing the React component: a real GFM subset, sanitized so no raw HTML
 * or executable content survives.
 *
 * Safety model (equivalent to "sanitize runs last"): untrusted text only ever
 * enters the output as HTML-escaped text or as a protocol-validated href/src.
 * Markup is exclusively this module's own whitelisted element set — raw HTML in
 * the source is escaped, never interpreted — so the returned string is safe to
 * assign via innerHTML. Links open in a new tab with rel="noopener" (AC3).
 *
 * Dual use: required as CommonJS by the broker's node:test suite, and loaded in
 * the browser as `window.AEEMarkdown`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEEMarkdown = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Only http(s) and mailto links are allowed (the value here is already
  // HTML-escaped, so quotes/angle-brackets cannot break out of the attribute).
  // Anything else (javascript:, data:, vbscript:, ...) => null so the caller
  // keeps the visible text but drops the dangerous href.
  function sanitizeUrl(url) {
    var u = String(url == null ? '' : url).trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    return null;
  }

  function link(url, innerHtml) {
    var href = sanitizeUrl(url);
    if (!href) return innerHtml;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + innerHtml + '</a>';
  }

  // Emphasis on already-escaped text: strikethrough, then bold, then italic.
  function emphasis(s) {
    return s
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>')
      .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  }

  // Inline rendering. Code spans and links/images are extracted to placeholders
  // first so emphasis never rewrites a URL or code content; restored at the end.
  function inline(src) {
    var codes = [];
    var holes = [];
    var s = String(src == null ? '' : src);

    // Placeholders are wrapped in the NUL char, which render() strips from the
    // input up front, so a token can never collide with user text and (being
    // none of & < > " ') it survives escapeHtml and carries no emphasis chars.
    var Z = String.fromCharCode(0);
    var codeRe = new RegExp(Z + 'C(\\d+)' + Z, 'g');
    var holeRe = new RegExp(Z + 'H(\\d+)' + Z, 'g');
    function codeTok(i) { return Z + 'C' + i + Z; }
    function holeTok(i) { return Z + 'H' + i + Z; }

    // 1) protect code spans (raw; escaped on restore)
    s = s.replace(/(`+)([\s\S]*?)\1/g, function (m, ticks, code) {
      return codeTok(codes.push(code.replace(/^ (.*?) $/, '$1')) - 1);
    });

    // 2) escape everything else
    s = escapeHtml(s);

    // 3) images ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, function (m, alt, url) {
      var src2 = sanitizeUrl(url);
      var html = src2 ? '<img src="' + src2 + '" alt="' + alt + '" />' : escapeHtml(alt);
      return holeTok(holes.push(html) - 1);
    });

    // 4) links [text](url)
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, function (m, text, url) {
      return holeTok(holes.push(link(url, emphasis(text))) - 1);
    });

    // 5) autolinks (angle brackets are &lt;/&gt; after escaping)
    s = s.replace(/&lt;((?:https?:|mailto:)[^\s<>]+?)&gt;/g, function (m, url) {
      return holeTok(holes.push(link(url, url)) - 1);
    });

    // 6) emphasis on the rest
    s = emphasis(s);

    // 7) restore holes, then code spans (code may sit inside a restored hole)
    s = s.replace(holeRe, function (m, i) { return holes[Number(i)]; });
    s = s.replace(codeRe, function (m, i) { return '<code>' + escapeHtml(codes[Number(i)]) + '</code>'; });
    return s;
  }

  function isBlank(line) { return /^\s*$/.test(line); }

  function isBlockStart(line) {
    return /^\s{0,3}(#{1,6})\s+/.test(line)          // heading
      || /^\s{0,3}(`{3,}|~{3,})/.test(line)          // fence
      || /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line) // hr
      || /^\s{0,3}>/.test(line)                       // blockquote
      || /^(\s*)([-*+]|\d+[.)])\s+/.test(line);       // list item
  }

  // A GFM table delimiter row, e.g. `| --- | :--: |`.
  function isTableDelimiter(line) {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.indexOf('-') >= 0;
  }

  function splitCells(row) {
    return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  }

  function render(src) {
    if (src == null) return '';
    var text = String(src).replace(new RegExp(String.fromCharCode(0), 'g'), '').replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }

      // fenced code
      var fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        var ch = fence[1][0];
        var len = fence[1].length;
        var closeRe = new RegExp('^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
        var buf = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++; // consume closing fence
        out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // ATX heading
      var h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { var n = h[1].length; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); i++; continue; }

      // horizontal rule
      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr />'); i++; continue; }

      // blockquote (collect contiguous quoted lines, strip one level, recurse)
      if (/^\s{0,3}>/.test(line)) {
        var qbuf = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { qbuf.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
        out.push('<blockquote>' + render(qbuf.join('\n')) + '</blockquote>');
        continue;
      }

      // GFM table
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
        var header = splitCells(line);
        i += 2; // header + delimiter
        var rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0 && !isBlockStart(lines[i])) {
          rows.push(splitCells(lines[i])); i++;
        }
        var thead = '<thead><tr>' + header.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead>';
        var tbody = '<tbody>' + rows.map(function (r) {
          return '<tr>' + header.map(function (_c, ci) { return '<td>' + inline(r[ci] || '') + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody>';
        out.push('<table>' + thead + tbody + '</table>');
        continue;
      }

      // list (single level; ordered vs unordered from the first marker)
      var li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        var ordered = /\d/.test(li[2]);
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) break;
          var isOrdered = /\d/.test(m[2]);
          if (isOrdered !== ordered) break;
          items.push(inline(m[3]));
          i++;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map(function (it) { return '<li>' + it + '</li>'; }).join('') + '</' + tag + '>');
        continue;
      }

      // paragraph (join soft-wrapped lines with a space, GFM default)
      var pbuf = [];
      while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) { pbuf.push(lines[i]); i++; }
      out.push('<p>' + inline(pbuf.join('\n').replace(/\n/g, ' ')) + '</p>');
    }

    return out.join('\n');
  }

  return { render: render, escapeHtml: escapeHtml, sanitizeUrl: sanitizeUrl };
}));
