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

        // Prefer role-based selectors for semantic elements
        if (role && ['row', 'listitem', 'option', 'tab', 'treeitem', 'gridcell', 'menuitem'].includes(role)) {
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
        if (role && ['table', 'grid', 'list', 'rowgroup', 'tablist', 'tree', 'menu', 'listbox'].includes(role)) {
          return '[role="' + role + '"]';
        }
        const cls = cleanClasses(parent.className);
        if (cls) {
          return parent.tagName.toLowerCase() + '.' + cls.split(/\\s+/)[0];
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
            if (prefix.length > 1 && prefix.includes('/')) {
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
      return deduped.slice(0, 20).map(c => ({
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

/**
 * Builds a script that counts elements matching a selector, checking main doc + iframes.
 */
export function buildSelectorCountScript(selector: string): string {
  const selectorJson = JSON.stringify(selector);
  return `
    (() => {
      // Try main document first
      let count = document.querySelectorAll(${selectorJson}).length;
      if (count > 0) return count;

      // Try same-origin iframes
      try {
        for (const iframe of document.querySelectorAll('iframe')) {
          try {
            if (iframe.contentDocument) {
              count = iframe.contentDocument.querySelectorAll(${selectorJson}).length;
              if (count > 0) return count;
              // Nested iframes
              for (const nested of iframe.contentDocument.querySelectorAll('iframe')) {
                try {
                  if (nested.contentDocument) {
                    count = nested.contentDocument.querySelectorAll(${selectorJson}).length;
                    if (count > 0) return count;
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
      } catch (e) {}

      return 0;
    })()
  `;
}
