export interface CandidateSelector {
  selector: string;
  count: number;
  sampleTexts: string[];
}

/**
 * Helper JS snippet: returns an array of searchable documents (main + same-origin iframe docs).
 * Used by discovery, outline, and extraction scripts to pierce iframe boundaries.
 */
const COLLECT_DOCS_SNIPPET = `
  function __collectDocs() {
    const docs = [document];
    try {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          if (iframe.contentDocument && iframe.contentDocument.body) {
            docs.push(iframe.contentDocument);
            // Also check nested iframes (one level deep)
            for (const nested of iframe.contentDocument.querySelectorAll('iframe')) {
              try {
                if (nested.contentDocument && nested.contentDocument.body) {
                  docs.push(nested.contentDocument);
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
    return docs;
  }
`;

/**
 * Helper JS snippet: querySelectorAll across main doc + iframe docs.
 * Returns elements from the first document that has matches.
 */
const QSA_ACROSS_FRAMES_SNIPPET = `
  function __qsaAcrossFrames(selector) {
    const docs = __collectDocs();
    for (const doc of docs) {
      try {
        const els = doc.querySelectorAll(selector);
        if (els.length > 0) return Array.from(els);
      } catch (e) {}
    }
    return [];
  }

  function __qsaCountAcrossFrames(selector) {
    const docs = __collectDocs();
    let total = 0;
    for (const doc of docs) {
      try {
        total += doc.querySelectorAll(selector).length;
      } catch (e) {}
    }
    return total;
  }
`;

/**
 * Structural auto-discovery: walks the DOM looking for parents with many
 * similar children. Works on Framer/React sites where classes are hashed
 * and the outline is too noisy for an LLM to parse.
 * Also detects ARIA role-based tables/lists (e.g. Zoho CRM, Salesforce).
 * Searches inside same-origin iframes automatically.
 */
export function buildStructuralDiscoveryScript(): string {
  return `
    (() => {
      const MIN_REPEATING = 3;

      const SKIP_TAGS = new Set([
        'script', 'style', 'noscript', 'link', 'meta', 'br', 'hr', 'img',
        'svg', 'path', 'symbol', 'use', 'defs', 'clippath', 'g', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse',
        'template', 'slot',
      ]);

      // Classes that are framework artifacts and should be ignored
      const JUNK_CLASSES = new Set(['undefined', 'null', 'false', 'true', 'none']);

      function cleanClasses(raw) {
        if (typeof raw !== 'string') return '';
        return raw.trim().split(/\\s+/).filter(c => c && !JUNK_CLASSES.has(c)).join(' ');
      }

      function getSignature(el) {
        const tag = el.tagName?.toLowerCase() || '';
        if (SKIP_TAGS.has(tag)) return '__skip__';
        const cls = cleanClasses(el.className).split(/\\s+/).sort().join(' ');
        const role = el.getAttribute('role') || '';
        const hasHref = el.hasAttribute('href') ? 'href' : '';
        return [tag, cls, role, hasHref].filter(Boolean).join('|');
      }

      function buildSelector(el) {
        const tag = el.tagName?.toLowerCase() || '';
        const role = el.getAttribute('role');
        const cls = cleanClasses(el.className);

        // Prefer role-based selectors for semantic elements, but include class for specificity
        if (role && ['row', 'listitem', 'option', 'tab', 'treeitem', 'gridcell', 'menuitem'].includes(role)) {
          if (cls) {
            const first = cls.split(/\\s+/)[0];
            return tag + '.' + CSS.escape(first) + '[role="' + role + '"]';
          }
          return '[role="' + role + '"]';
        }

        if (cls) {
          const first = cls.split(/\\s+/)[0];
          return tag + '.' + first;
        }
        if (role) return tag + '[role="' + role + '"]';
        return tag;
      }

      function buildParentSelector(parent) {
        if (parent.id) return '#' + CSS.escape(parent.id);
        const role = parent.getAttribute('role');
        const cls = cleanClasses(parent.className);
        const tag = parent.tagName.toLowerCase();
        if (role && ['table', 'grid', 'list', 'rowgroup', 'tablist', 'tree', 'menu', 'listbox'].includes(role)) {
          if (cls) {
            const firstClass = cls.split(/\\s+/)[0];
            return tag + '.' + CSS.escape(firstClass) + '[role="' + role + '"]';
          }
          return '[role="' + role + '"]';
        }
        if (cls) {
          return tag + '.' + cls.split(/\\s+/)[0];
        }
        return '';
      }

      // Bare generic tags that are too broad to be useful selectors on their own
      const GENERIC_TAGS = new Set(['div', 'span', 'a', 'p', 'li', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside']);

      function getSampleText(el) {
        return (el.innerText || el.textContent || '').trim().split('\\n')[0].slice(0, 80);
      }

      // --- Discovery function that works on any document ---
      function discoverInDoc(doc) {
        const candidates = [];

        // --- Phase 1: ARIA role-based table/list detection ---
        const roleTables = doc.querySelectorAll('[role="table"], [role="grid"]');
        for (const table of roleTables) {
          // Build a prefix selector to scope to this specific table
          let tablePrefix = '';
          if (table.id) {
            tablePrefix = '#' + CSS.escape(table.id);
          } else {
            const tableCls = cleanClasses(table.className);
            if (tableCls) {
              tablePrefix = table.tagName.toLowerCase() + '.' + CSS.escape(tableCls.split(/\\s+/)[0]);
            } else {
              tablePrefix = '[role="' + table.getAttribute('role') + '"]';
            }
          }

          // Find all rowgroups and pick the body (the one with the most rows)
          const allRowgroups = Array.from(table.querySelectorAll('[role="rowgroup"]'));
          let bodyGroup = null;
          let bestRowCount = 0;

          for (const rg of allRowgroups) {
            const directRows = rg.querySelectorAll(':scope > [role="row"]');
            const allRows = directRows.length > 0 ? directRows : rg.querySelectorAll('[role="row"]');
            if (allRows.length > bestRowCount) {
              bestRowCount = allRows.length;
              bodyGroup = rg;
            }
          }

          // Fall back to the table itself if no rowgroups found
          if (!bodyGroup) bodyGroup = table;

          const rows = bodyGroup.querySelectorAll(':scope > [role="row"]');
          // If no direct children, try descendants (for nested structures)
          const rowList = rows.length >= MIN_REPEATING ? rows : bodyGroup.querySelectorAll('[role="row"]');
          if (rowList.length < MIN_REPEATING) continue;

          // Build a reliable, scoped selector for these rows
          let rowSelector = '';
          if (bodyGroup.id) {
            rowSelector = '#' + CSS.escape(bodyGroup.id) + ' > [role="row"]';
          } else {
            // Try class-based selector first (more specific than role-based)
            const rgCls = cleanClasses(bodyGroup.className);
            const bodyRole = bodyGroup.getAttribute('role');

            if (rgCls) {
              const firstClass = rgCls.split(/\\s+/)[0];
              rowSelector = tablePrefix + ' .' + CSS.escape(firstClass) + ' > [role="row"]';
            } else if (bodyRole === 'rowgroup' && allRowgroups.length > 1) {
              // Use nth-child to distinguish from header rowgroup, scoped to table
              const idx = allRowgroups.indexOf(bodyGroup);
              if (idx >= 0) {
                const parentOfRg = bodyGroup.parentElement;
                if (parentOfRg) {
                  const siblingIdx = Array.from(parentOfRg.children).indexOf(bodyGroup);
                  if (siblingIdx >= 0) {
                    rowSelector = tablePrefix + ' [role="rowgroup"]:nth-child(' + (siblingIdx + 1) + ') > [role="row"]';
                  }
                }
              }
              if (!rowSelector) {
                rowSelector = tablePrefix + ' [role="rowgroup"] > [role="row"]';
              }
            } else {
              rowSelector = tablePrefix + ' [role="row"]';
            }
          }

          // Verify
          let count;
          try { count = doc.querySelectorAll(rowSelector).length; } catch { continue; }

          // If the selector also picks up header rows, try to exclude them
          if (count > rowList.length) {
            // Try class-based body selector if available
            const rgCls = cleanClasses(bodyGroup.className);
            if (rgCls) {
              const betterSelector = tablePrefix + ' .' + CSS.escape(rgCls.split(/\\s+/)[0]) + ' > [role="row"]';
              try {
                const betterCount = doc.querySelectorAll(betterSelector).length;
                if (betterCount >= MIN_REPEATING && betterCount <= count) {
                  rowSelector = betterSelector;
                  count = betterCount;
                }
              } catch {}
            }
            // Also try last-of-type as fallback
            if (count > rowList.length) {
              const betterSelector = tablePrefix + ' [role="rowgroup"]:last-of-type > [role="row"]';
              try {
                const betterCount = doc.querySelectorAll(betterSelector).length;
                if (betterCount >= MIN_REPEATING && betterCount <= count) {
                  rowSelector = betterSelector;
                  count = betterCount;
                }
              } catch {}
            }
          }

          if (count < MIN_REPEATING) continue;

          const sampleRows = Array.from(rowList).slice(0, 10);
          const hasLinks = sampleRows.some(r => r.querySelector('a[href]'));
          const hasText = sampleRows.some(r => (r.innerText || '').trim().length > 10);

          // ARIA role-based selectors get a strong boost (10x) — they are semantically correct
          const countScore = Math.log2(count + 1);
          candidates.push({
            selector: rowSelector,
            count,
            score: countScore * (hasLinks ? 3 : 1) * (hasText ? 2 : 1) * 10,
            sampleTexts: sampleRows.map(r => getSampleText(r)),
          });

          // Also add a candidate for custom element table rows (e.g. lyte-exptable-tr)
          const firstRow = rowList[0];
          if (firstRow) {
            const rowTag = firstRow.tagName?.toLowerCase() || '';
            if (rowTag.includes('-') && rowTag !== bodyGroup.tagName?.toLowerCase()) {
              const customSelector = tablePrefix + ' ' + rowTag;
              try {
                const customCount = doc.querySelectorAll(customSelector).length;
                if (customCount >= MIN_REPEATING) {
                  const headerRowgroup = allRowgroups.find(rg => rg !== bodyGroup);
                  const headerHasCustomTag = headerRowgroup && headerRowgroup.querySelector(rowTag);
                  const effectiveCount = headerHasCustomTag ? customCount - 1 : customCount;
                  if (effectiveCount >= MIN_REPEATING) {
                    candidates.push({
                      selector: customSelector,
                      count: customCount,
                      score: Math.log2(customCount + 1) * (hasLinks ? 3 : 1) * (hasText ? 2 : 1) * 8,
                      sampleTexts: sampleRows.map(r => getSampleText(r)),
                    });
                  }
                }
              } catch {}
            }
          }
        }

        // Also detect ARIA lists
        const roleLists = doc.querySelectorAll('[role="list"], [role="listbox"], [role="menu"], [role="tablist"]');
        for (const list of roleLists) {
          const itemRole = list.getAttribute('role') === 'tablist' ? 'tab'
            : list.getAttribute('role') === 'menu' ? 'menuitem'
            : list.getAttribute('role') === 'listbox' ? 'option' : 'listitem';
          const items = list.querySelectorAll(':scope > [role="' + itemRole + '"]');
          if (items.length < MIN_REPEATING) continue;

          let selector = '';
          if (list.id) {
            selector = '#' + CSS.escape(list.id) + ' > [role="' + itemRole + '"]';
          } else {
            selector = '[role="' + list.getAttribute('role') + '"] > [role="' + itemRole + '"]';
          }

          let count;
          try { count = doc.querySelectorAll(selector).length; } catch { continue; }
          if (count < MIN_REPEATING) continue;

          const sampleItems = Array.from(items).slice(0, 10);
          const hasLinks = sampleItems.some(el => el.querySelector('a[href]'));
          const hasText = sampleItems.some(el => (el.innerText || '').trim().length > 10);

          const countScore = Math.log2(count + 1);
          candidates.push({
            selector,
            count,
            score: countScore * (hasLinks ? 3 : 1) * (hasText ? 2 : 1) * 10,
            sampleTexts: sampleItems.map(el => getSampleText(el)),
          });
        }

        // --- Phase 2: Signature-based structural discovery ---
        const allElements = doc.querySelectorAll('*');
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
            const parentSel = buildParentSelector(parent);

            const fullSelector = parentSel ? parentSel + ' > ' + childSel : childSel;

            // Verify the selector actually matches the expected count
            let count;
            try {
              count = doc.querySelectorAll(fullSelector).length;
            } catch { continue; }

            if (count < MIN_REPEATING) continue;

            // Score: prefer elements with meaningful content, penalize overly broad selectors
            const hasLinks = members.some(m => m.querySelector('a[href]'));
            const hasText = members.some(m => (m.innerText || '').trim().length > 10);
            const samples = members.slice(0, 10).map(m => getSampleText(m));
            const nonEmptySamples = samples.filter(s => s.length > 0).length;

            // Skip candidates with no visible text at all
            if (nonEmptySamples === 0) continue;

            // Logarithmic count so 10 items scores similarly to 100 — prevents broad selectors from dominating
            const countScore = Math.log2(count + 1);
            // Bare tag without parent context is almost certainly too broad
            const isBareBroad = !parentSel && GENERIC_TAGS.has(childSel);
            const specificityBonus = isBareBroad ? 0.1 : 1;
            // Role-based selectors are more reliable than class-based
            const roleBonus = childSel.includes('[role=') ? 2 : 1;

            const score = countScore * (hasLinks ? 3 : 1) * (hasText ? 2 : 1) * specificityBonus * roleBonus;

            candidates.push({
              selector: fullSelector,
              count,
              score,
              sampleTexts: samples,
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
            // Trim prefix to the last '/' boundary so we don't get partial path segments
            const lastSlash = prefix.lastIndexOf('/');
            if (lastSlash >= 0) prefix = prefix.slice(0, lastSlash + 1);

            // Reject overly generic prefixes like './', '/', '../', 'http://host/', 'https://'
            // Require at least one meaningful path segment after the origin/scheme
            const stripped = prefix.replace(/^(\\.?\\.?\\/|https?:\\/\\/[^\\/]*\\/?)/, '');
            const isSpecific = stripped.length > 0 && stripped !== '/';

            if (isSpecific && prefix.length > 1 && prefix.includes('/')) {
              const hrefSelector = 'a[href^="' + prefix + '"]';
              let count;
              try { count = doc.querySelectorAll(hrefSelector).length; } catch { continue; }
              if (count >= MIN_REPEATING) {
                const samples = children.slice(0, 10).map(c => getSampleText(c));
                candidates.push({
                  selector: hrefSelector,
                  count,
                  score: Math.log2(count + 1) * 5,
                  sampleTexts: samples,
                });
              }
            }
          }
        }

        // --- Phase 3: Class-based global discovery ---
        // Find repeated elements with the same class(es) across the entire document,
        // even if they are NOT siblings (e.g. same component in different sections).
        const classGroups = {};
        const allEls = doc.querySelectorAll('*');
        for (const el of allEls) {
          const tag = el.tagName?.toLowerCase() || '';
          if (SKIP_TAGS.has(tag)) continue;
          const cls = cleanClasses(el.className);
          if (!cls) continue;
          // Use full sorted class list as key to group identical elements
          const sorted = cls.split(/\\s+/).sort().join('.');
          const key = tag + '.' + sorted;
          if (!classGroups[key]) classGroups[key] = [];
          classGroups[key].push(el);
        }

        for (const [key, members] of Object.entries(classGroups)) {
          if (members.length < MIN_REPEATING) continue;

          // Build selector from first class (most human-readable)
          const representative = members[0];
          const tag = representative.tagName.toLowerCase();
          const cls = cleanClasses(representative.className);
          const classes = cls.split(/\\s+/);
          // Use the most specific (longest) class name for the selector
          const bestClass = classes.reduce((a, b) => a.length >= b.length ? a : b, '');
          const selector = tag + '.' + CSS.escape(bestClass);

          let count;
          try { count = doc.querySelectorAll(selector).length; } catch { continue; }
          if (count < MIN_REPEATING) continue;

          // If selector matches way more than our group, try with two classes for specificity
          let finalSelector = selector;
          if (count > members.length * 2 && classes.length > 1) {
            const twoClassSel = tag + '.' + CSS.escape(classes[0]) + '.' + CSS.escape(classes[1]);
            try {
              const twoCount = doc.querySelectorAll(twoClassSel).length;
              if (twoCount >= MIN_REPEATING && twoCount <= count) {
                finalSelector = twoClassSel;
                count = twoCount;
              }
            } catch {}
          }

          const samples = members.slice(0, 10).map(m => getSampleText(m));
          const nonEmptySamples = samples.filter(s => s.length > 0).length;
          if (nonEmptySamples === 0) continue;

          const hasLinks = members.slice(0, 10).some(m => m.querySelector('a[href]'));
          const hasText = members.slice(0, 10).some(m => (m.innerText || '').trim().length > 10);
          const countScore = Math.log2(count + 1);

          candidates.push({
            selector: finalSelector,
            count,
            score: countScore * (hasLinks ? 3 : 1) * (hasText ? 2 : 1) * 1.5,
            sampleTexts: samples,
          });
        }

        return candidates;
      }

      // --- Run discovery on main document + same-origin iframes ---
      let allCandidates = discoverInDoc(document);

      try {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            if (iframe.contentDocument && iframe.contentDocument.body) {
              const frameCandidates = discoverInDoc(iframe.contentDocument);
              allCandidates = allCandidates.concat(frameCandidates);
              // Also check nested iframes
              try {
                for (const nested of iframe.contentDocument.querySelectorAll('iframe')) {
                  try {
                    if (nested.contentDocument && nested.contentDocument.body) {
                      allCandidates = allCandidates.concat(discoverInDoc(nested.contentDocument));
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          } catch (e) {
            // Cross-origin iframe — skip (Playwright frame API needed for these)
          }
        }
      } catch (e) {}

      // Deduplicate by selector, keeping highest-scored entry
      const seen = {};
      for (const c of allCandidates) {
        if (!seen[c.selector] || seen[c.selector].score < c.score) {
          seen[c.selector] = c;
        }
      }
      const deduped = Object.values(seen);

      // Sort by score descending, return top 50
      deduped.sort((a, b) => b.score - a.score);
      return deduped.slice(0, 30).map(c => ({
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
      const MAX_DEPTH = 8;
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

        // Collect direct text node content (text that belongs to this element, not its children)
        let text = '';
        const directTexts = [];
        for (let i = 0; i < el.childNodes.length; i++) {
          if (el.childNodes[i].nodeType === 3) {
            const t = el.childNodes[i].textContent?.trim();
            if (t) directTexts.push(t);
          }
        }
        if (directTexts.length > 0) {
          const joined = directTexts.join(' ').slice(0, MAX_TEXT);
          text = ' "' + joined + (directTexts.join(' ').length > MAX_TEXT ? '...' : '') + '"';
        } else if (el.children.length === 0) {
          // Leaf element with no child elements — show its textContent
          const t = (el.textContent || '').trim();
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

      let result = outline(document.body, 0);

      // Also outline same-origin iframe content
      try {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            if (iframe.contentDocument && iframe.contentDocument.body) {
              const iframeId = iframe.id || iframe.name || iframe.src?.slice(0, 60) || 'iframe';
              result += '\\n<!-- IFRAME: ' + iframeId + ' -->\\n';
              result += outline(iframe.contentDocument.body, 0);
            }
          } catch (e) {
            // Cross-origin iframe
          }
        }
      } catch (e) {}

      return result;
    })()
  `;
}

export interface ElementFromPointResult {
  selector: string;
  matchCount: number;
  element: {
    textContent: string;
    innerText: string;
    tagName: string;
    id: string;
    href: string;
    outerHTML: string;
  };
}

/**
 * Given (x, y) pixel coordinates, finds the DOM element at that point,
 * walks up to find the repeating-item container, and derives a CSS selector
 * that matches all similar siblings.
 */
export function buildElementFromPointScript(x: number, y: number): string {
  return `
    (() => {
      const MAX_TEXT = 500;
      const MAX_HTML = 1000;

      const SKIP_TAGS = new Set([
        'script', 'style', 'noscript', 'link', 'meta', 'br', 'hr',
        'svg', 'path', 'symbol', 'use', 'defs', 'clippath', 'g', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse',
        'template', 'slot',
      ]);

      const JUNK_CLASSES = new Set(['undefined', 'null', 'false', 'true', 'none']);

      function cleanClasses(raw) {
        if (typeof raw !== 'string') return '';
        return raw.trim().split(/\\s+/).filter(c => c && !JUNK_CLASSES.has(c)).join(' ');
      }

      function getSignature(el) {
        const tag = el.tagName?.toLowerCase() || '';
        if (SKIP_TAGS.has(tag)) return '__skip__';
        const cls = cleanClasses(el.className).split(/\\s+/).sort().join(' ');
        const role = el.getAttribute('role') || '';
        return [tag, cls, role].filter(Boolean).join('|');
      }

      function buildSelector(el) {
        const tag = el.tagName?.toLowerCase() || '';
        const role = el.getAttribute('role');
        const cls = cleanClasses(el.className);
        if (role && ['row', 'listitem', 'option', 'tab', 'treeitem', 'gridcell', 'menuitem'].includes(role)) {
          // Include class alongside role for specificity
          if (cls) {
            const first = cls.split(/\\s+/)[0];
            return tag + '.' + CSS.escape(first) + '[role="' + role + '"]';
          }
          return '[role="' + role + '"]';
        }
        if (cls) {
          const first = cls.split(/\\s+/)[0];
          return tag + '.' + first;
        }
        if (role) return tag + '[role="' + role + '"]';
        return tag;
      }

      function buildParentSelector(parent) {
        if (parent.id) return '#' + CSS.escape(parent.id);
        const role = parent.getAttribute('role');
        const cls = cleanClasses(parent.className);
        const tag = parent.tagName.toLowerCase();
        if (role && ['table', 'grid', 'list', 'rowgroup', 'tablist', 'tree', 'menu', 'listbox'].includes(role)) {
          // Include class alongside role for specificity
          if (cls) {
            const firstClass = cls.split(/\\s+/)[0];
            return tag + '.' + CSS.escape(firstClass) + '[role="' + role + '"]';
          }
          return '[role="' + role + '"]';
        }
        if (cls) {
          return tag + '.' + cls.split(/\\s+/)[0];
        }
        return '';
      }

      // Try to refine a selector that matches too many elements
      function refineSelector(bestMatch, doc) {
        const el = bestMatch.element;
        const parent = el.parentElement;
        if (!parent) return;

        const siblingCount = bestMatch.siblingCount;
        // If selector matches roughly the right count, no refinement needed
        if (bestMatch.matchCount <= siblingCount * 1.5) return;

        const parentSel = buildParentSelector(parent);

        // Strategy 1: Try different child class combinations for more specificity
        const cls = cleanClasses(el.className);
        if (cls) {
          const classes = cls.split(/\\s+/);
          if (classes.length > 1) {
            const role = el.getAttribute('role');
            const tag = el.tagName.toLowerCase();
            let bestRefinedSelector = bestMatch.selector;
            let bestRefinedCount = bestMatch.matchCount;

            // Try each individual class
            for (const c of classes) {
              let childSel = tag + '.' + CSS.escape(c);
              if (role) childSel += '[role="' + role + '"]';
              const candidateSelector = parentSel ? parentSel + ' > ' + childSel : childSel;
              try {
                const count = doc.querySelectorAll(candidateSelector).length;
                if (count >= 2 && count < bestRefinedCount) {
                  bestRefinedSelector = candidateSelector;
                  bestRefinedCount = count;
                }
              } catch {}
            }

            // Try pairs of classes
            for (let i = 0; i < classes.length && i < 5; i++) {
              for (let j = i + 1; j < classes.length && j < 5; j++) {
                let childSel = tag + '.' + CSS.escape(classes[i]) + '.' + CSS.escape(classes[j]);
                if (role) childSel += '[role="' + role + '"]';
                const candidateSelector = parentSel ? parentSel + ' > ' + childSel : childSel;
                try {
                  const count = doc.querySelectorAll(candidateSelector).length;
                  if (count >= 2 && count < bestRefinedCount) {
                    bestRefinedSelector = candidateSelector;
                    bestRefinedCount = count;
                  }
                } catch {}
              }
            }

            if (bestRefinedSelector !== bestMatch.selector) {
              bestMatch.selector = bestRefinedSelector;
              bestMatch.matchCount = bestRefinedCount;
            }
          }
        }

        // Strategy 2: Scope with nearest ancestor that has an ID
        if (bestMatch.matchCount > siblingCount * 1.5) {
          let ancestor = parent.parentElement;
          for (let i = 0; i < 5 && ancestor && ancestor !== doc.body; i++) {
            if (ancestor.id) {
              const scopedSelector = '#' + CSS.escape(ancestor.id) + ' ' + bestMatch.selector;
              try {
                const count = doc.querySelectorAll(scopedSelector).length;
                if (count >= 2 && count < bestMatch.matchCount) {
                  bestMatch.selector = scopedSelector;
                  bestMatch.matchCount = count;
                  break;
                }
              } catch {}
            }
            ancestor = ancestor.parentElement;
          }
        }

        // Strategy 3: Scope with nearest ancestor that has a unique class
        if (bestMatch.matchCount > siblingCount * 1.5) {
          let ancestor = parent.parentElement;
          for (let i = 0; i < 5 && ancestor && ancestor !== doc.body; i++) {
            const aCls = cleanClasses(ancestor.className);
            if (aCls) {
              const aTag = ancestor.tagName.toLowerCase();
              const aFirstClass = aCls.split(/\\s+/)[0];
              const ancestorSel = aTag + '.' + CSS.escape(aFirstClass);
              const scopedSelector = ancestorSel + ' ' + bestMatch.selector;
              try {
                const count = doc.querySelectorAll(scopedSelector).length;
                if (count >= 2 && count < bestMatch.matchCount) {
                  bestMatch.selector = scopedSelector;
                  bestMatch.matchCount = count;
                  break;
                }
              } catch {}
            }
            ancestor = ancestor.parentElement;
          }
        }
      }

      // Coordinates are pre-converted to CSS pixels by the caller
      const px = ${x};
      const py = ${y};

      // Try main document first, then iframes
      let hitEl = document.elementFromPoint(px, py);

      // If we hit an iframe, try inside it
      if (hitEl && hitEl.tagName?.toLowerCase() === 'iframe') {
        try {
          const iframeDoc = hitEl.contentDocument;
          if (iframeDoc) {
            const rect = hitEl.getBoundingClientRect();
            const innerX = px - rect.left;
            const innerY = py - rect.top;
            const innerHit = iframeDoc.elementFromPoint(innerX, innerY);
            if (innerHit) hitEl = innerHit;
          }
        } catch (e) {}
      }

      if (!hitEl) return null;

      // Walk up from the hit element to find a repeating container pattern
      let current = hitEl;
      let bestMatch = null;
      const MIN_SIBLINGS = 2;

      for (let depth = 0; depth < 15 && current && current !== document.body && current !== document.documentElement; depth++) {
        const parent = current.parentElement;
        if (!parent) break;

        const children = Array.from(parent.children);
        if (children.length >= MIN_SIBLINGS) {
          const currentSig = getSignature(current);
          if (currentSig !== '__skip__') {
            const matchingSiblings = children.filter(c => getSignature(c) === currentSig);
            if (matchingSiblings.length >= MIN_SIBLINGS) {
              const childSel = buildSelector(current);
              const parentSel = buildParentSelector(parent);
              const fullSelector = parentSel ? parentSel + ' > ' + childSel : childSel;

              // Verify the selector matches in the document
              let matchCount;
              const doc = current.ownerDocument || document;
              try {
                matchCount = doc.querySelectorAll(fullSelector).length;
              } catch { matchCount = 0; }

              if (matchCount >= MIN_SIBLINGS) {
                // Prefer deeper matches (more specific) but also consider count
                // Keep walking up — a higher ancestor might capture a better group
                bestMatch = {
                  selector: fullSelector,
                  matchCount,
                  element: current,
                  depth,
                  siblingCount: matchingSiblings.length,
                };
              }
            }
          }
        }

        current = parent;
      }

      if (!bestMatch) return null;

      // Refine the selector if it matches too many elements
      const refDoc = bestMatch.element.ownerDocument || document;
      refineSelector(bestMatch, refDoc);

      const el = bestMatch.element;
      return {
        selector: bestMatch.selector,
        matchCount: bestMatch.matchCount,
        element: {
          textContent: (el.textContent || '').trim().slice(0, MAX_TEXT),
          innerText: (el.innerText || '').trim().slice(0, MAX_TEXT),
          tagName: el.tagName?.toLowerCase() || '',
          id: el.id || '',
          href: el.href || el.querySelector('a')?.href || '',
          outerHTML: el.outerHTML.slice(0, MAX_HTML),
        },
      };
    })()
  `;
}

export function buildElementExtractionScript(selector: string): string {
  const selectorJson = JSON.stringify(selector);
  return `
    (() => {
      const MAX_TEXT = 500;
      const MAX_HTML = 1000;

      function extractFromEls(els) {
        return Array.from(els).map(el => ({
          textContent: (el.textContent || '').trim().slice(0, MAX_TEXT),
          innerText: (el.innerText || '').trim().slice(0, MAX_TEXT),
          tagName: el.tagName?.toLowerCase() || '',
          id: el.id || '',
          href: el.href || el.querySelector('a')?.href || '',
          outerHTML: el.outerHTML.slice(0, MAX_HTML),
        }));
      }

      // Try main document first
      let els = document.querySelectorAll(${selectorJson});
      if (els.length > 0) return extractFromEls(els);

      // Try same-origin iframes
      try {
        for (const iframe of document.querySelectorAll('iframe')) {
          try {
            if (iframe.contentDocument) {
              els = iframe.contentDocument.querySelectorAll(${selectorJson});
              if (els.length > 0) return extractFromEls(els);
              // Nested iframes
              for (const nested of iframe.contentDocument.querySelectorAll('iframe')) {
                try {
                  if (nested.contentDocument) {
                    els = nested.contentDocument.querySelectorAll(${selectorJson});
                    if (els.length > 0) return extractFromEls(els);
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
      } catch (e) {}

      return [];
    })()
  `;
}
