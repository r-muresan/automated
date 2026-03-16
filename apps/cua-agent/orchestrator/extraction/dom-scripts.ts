export interface CandidateSelector {
  selector: string;
  count: number;
  sampleTexts: string[];
}

/**
 * Structural auto-discovery: walks the DOM looking for parents with many
 * similar children. Works on Framer/React sites where classes are hashed
 * and the outline is too noisy for an LLM to parse.
 */
export function buildStructuralDiscoveryScript(): string {
  return `
    (() => {
      const MIN_REPEATING = 3;
      const candidates = [];

      const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'link', 'meta', 'br', 'hr', 'img']);

      function getSignature(el) {
        const tag = el.tagName?.toLowerCase() || '';
        if (SKIP_TAGS.has(tag)) return '__skip__';
        const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).sort().join(' ');
        const role = el.getAttribute('role') || '';
        const hasHref = el.hasAttribute('href') ? 'href' : '';
        return [tag, cls, role, hasHref].filter(Boolean).join('|');
      }

      function buildSelector(el) {
        const tag = el.tagName?.toLowerCase() || '';
        const cls = typeof el.className === 'string' ? el.className.trim() : '';
        if (cls) {
          const first = cls.split(/\\s+/)[0];
          return tag + '.' + first;
        }
        const role = el.getAttribute('role');
        if (role) return tag + '[role="' + role + '"]';
        return tag;
      }

      function getSampleText(el) {
        return (el.innerText || el.textContent || '').trim().split('\\n')[0].slice(0, 80);
      }

      // Walk all elements looking for parents with many same-signature children
      const allElements = document.querySelectorAll('*');
      const checked = new Set();

      for (const el of allElements) {
        const parent = el.parentElement;
        if (!parent || checked.has(parent)) continue;
        checked.add(parent);

        const children = Array.from(parent.children);
        if (children.length < MIN_REPEATING) continue;

        // Group children by structural signature
        const groups = {};
        for (const child of children) {
          const sig = getSignature(child);
          if (!groups[sig]) groups[sig] = [];
          groups[sig].push(child);
        }

        for (const [sig, members] of Object.entries(groups)) {
          if (sig === '__skip__' || members.length < MIN_REPEATING) continue;

          // Build a selector for this group
          const representative = members[0];
          const childSel = buildSelector(representative);

          // Try to build a more specific selector using parent context
          let parentSel = '';
          if (parent.id) {
            parentSel = '#' + parent.id;
          } else {
            const pCls = typeof parent.className === 'string' ? parent.className.trim() : '';
            if (pCls) {
              parentSel = parent.tagName.toLowerCase() + '.' + pCls.split(/\\s+/)[0];
            }
          }

          const fullSelector = parentSel ? parentSel + ' > ' + childSel : childSel;

          // Verify the selector actually matches the expected count
          let count;
          try {
            count = document.querySelectorAll(fullSelector).length;
          } catch { continue; }

          if (count < MIN_REPEATING) continue;

          // Score: prefer more matches, prefer elements with links/text
          const hasLinks = members.some(m => m.querySelector('a[href]'));
          const hasText = members.some(m => (m.innerText || '').trim().length > 10);

          candidates.push({
            selector: fullSelector,
            count,
            score: count * (hasLinks ? 3 : 1) * (hasText ? 2 : 1),
            sampleTexts: members.slice(0, 10).map(m => getSampleText(m)),
          });
        }

        // Also check if children share a common link pattern (e.g. a[href*="/portfolio/"])
        const childLinks = children.map(c => {
          const a = c.tagName === 'A' ? c : c.querySelector('a[href]');
          return a ? a.getAttribute('href') : null;
        }).filter(Boolean);

        if (childLinks.length >= MIN_REPEATING) {
          // Find common href prefix
          const sorted = childLinks.sort();
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          let prefix = '';
          for (let i = 0; i < Math.min(first.length, last.length); i++) {
            if (first[i] === last[i]) prefix += first[i];
            else break;
          }
          if (prefix.length > 1 && prefix.includes('/')) {
            const hrefSelector = 'a[href^="' + prefix + '"]';
            let count;
            try { count = document.querySelectorAll(hrefSelector).length; } catch { continue; }
            if (count >= MIN_REPEATING) {
              const samples = children.slice(0, 10).map(c => getSampleText(c));
              candidates.push({
                selector: hrefSelector,
                count,
                score: count * 5,
                sampleTexts: samples,
              });
            }
          }
        }
      }

      // Deduplicate by selector, keeping highest-scored entry
      const seen = {};
      for (const c of candidates) {
        if (!seen[c.selector] || seen[c.selector].score < c.score) {
          seen[c.selector] = c;
        }
      }
      const deduped = Object.values(seen);

      // Sort by score descending, return top 5
      deduped.sort((a, b) => b.score - a.score);
      return deduped.slice(0, 5).map(c => ({
        selector: c.selector,
        count: c.count,
        sampleTexts: c.sampleTexts,
      }));
    })()
  `;
}

export function buildDomOutlineScript(): string {
  return `
    (() => {
      const MAX_DEPTH = 6;
      const MAX_CHILDREN = 30;
      const MAX_TEXT = 60;

      function outline(el, depth) {
        if (depth > MAX_DEPTH) return '';
        const tag = el.tagName?.toLowerCase();
        if (!tag) return '';
        if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';

        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
          : '';
        const role = el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '';

        const rawHref = el.getAttribute('href') || '';
        const href = rawHref ? '[href="' + rawHref.slice(0, 60) + '"]' : '';

        let text = '';
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
          const t = el.childNodes[0].textContent?.trim() ?? '';
          if (t.length > 0) text = ' "' + t.slice(0, MAX_TEXT) + (t.length > MAX_TEXT ? '...' : '') + '"';
        }

        const indent = '  '.repeat(depth);
        let result = indent + '<' + tag + id + cls + role + href + '>' + text + '\\n';

        const children = Array.from(el.children).slice(0, MAX_CHILDREN);
        for (const child of children) {
          result += outline(child, depth + 1);
        }
        if (el.children.length > MAX_CHILDREN) {
          result += indent + '  <!-- +' + (el.children.length - MAX_CHILDREN) + ' more -->\\n';
        }
        return result;
      }

      return outline(document.body, 0);
    })()
  `;
}

export function buildElementExtractionScript(selector: string): string {
  const selectorJson = JSON.stringify(selector);
  return `
    (() => {
      const MAX_TEXT = 500;
      const MAX_HTML = 1000;
      const els = document.querySelectorAll(${selectorJson});
      return Array.from(els).map(el => ({
        textContent: (el.textContent || '').trim().slice(0, MAX_TEXT),
        innerText: (el.innerText || '').trim().slice(0, MAX_TEXT),
        tagName: el.tagName?.toLowerCase() || '',
        id: el.id || '',
        href: el.href || el.querySelector('a')?.href || '',
        outerHTML: el.outerHTML.slice(0, MAX_HTML),
      }));
    })()
  `;
}
