import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { computeWindow, prefixOffsets, computeCenteredScrollTop } from './virtual-window.js';

/**
 * Dependency-free list virtualization (#1685).
 *
 * Renders only the rows inside the scroller's viewport (plus a small overscan)
 * between two spacer <div>s that reserve the space of the off-screen rows, so
 * the DOM node count stays bounded no matter how long the list grows while the
 * scrollbar geometry is identical to a fully-rendered list.
 *
 * The component does NOT own the scroller — the caller passes its existing
 * `scrollerRef` so the surrounding auto-scroll / load-older / atBottom logic
 * keeps working unchanged. Row heights are unknown ahead of time (chat bubbles
 * and tool blocks vary wildly), so each mounted row is measured after layout;
 * un-mounted rows fall back to `estimateHeight` until they scroll into view.
 *
 * Props:
 *   items          array of items to render
 *   keyOf(item)    stable string key for an item (used for React keys +
 *                  the measured-height cache; heights survive scroll churn)
 *   renderItem(item, index) -> ReactNode
 *   scrollerRef    ref to the scrolling ancestor element
 *   estimateHeight starting guess for an unmeasured row (px)
 *   overscan       extra rows rendered above/below the viewport
 *   gap            vertical space between rows (px) — applied as margin so the
 *                  virtualized block matches a `gap`-spaced flex list
 *   rowStyle       optional style merged onto each row wrapper
 *   stickToBottom  when true, re-pin the scroller to the true bottom after each
 *                  measuring pass. Rows below the fold are estimated until they
 *                  are scrolled into view, so a single `scrollTop = scrollHeight`
 *                  (issued by the caller on load / send) lands short of the real
 *                  bottom; re-asserting it here as those rows mount and are
 *                  measured converges on the newest message within a frame or
 *                  two, and keeps the view pinned while a reply streams in
 *                  (#1710). The caller drives this from its own `atBottom`
 *                  intent, so scrolling up (atBottom → false) stops the re-pin
 *                  and older-history restore is never fought.
 *   scrollToKey    (#2310) when set to a key present in `items`, scroll that
 *                  row to the vertical center of the viewport. Off-screen rows
 *                  only have an estimated height until mounted, so this is a
 *                  converge-over-several-commits loop mirroring `stickToBottom`
 *                  above: each commit re-centers on the (possibly still
 *                  estimated) row, which pulls it into the rendered window,
 *                  where it gets measured — narrowing the estimate until the
 *                  scrollTop settles. Suppresses the `stickToBottom` re-pin
 *                  while active so the two never fight. A key not (yet) present
 *                  in `items` is a no-op — the caller is expected to backfill
 *                  and retry with the same key. `onScrolledToKey(key)` fires
 *                  once convergence is reached (or a bounded number of commits
 *                  have passed without settling, so a pathological layout can't
 *                  spin forever).
 *   onScrolledToKey(key) called once per distinct `scrollToKey` value, when the
 *                  row has been centered (see above).
 */
export default function VirtualList({
  items,
  keyOf,
  renderItem,
  scrollerRef,
  estimateHeight = 80,
  overscan = 6,
  gap = 0,
  rowStyle,
  stickToBottom = false,
  scrollToKey = null,
  onScrolledToKey,
}) {
  const innerRef = useRef(null);
  const heightsRef = useRef(new Map());   // key -> measured outer height (px, incl. gap)
  const rowEls = useRef(new Map());       // key -> mounted row element
  const refCache = useRef(new Map());     // key -> stable ref callback
  const rafRef = useRef(0);
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 });
  // measureTick only exists to force a recompute when the height cache changes.
  const [, setMeasureTick] = useState(0);
  // #2310: tracks the in-progress scrollToKey seek across commits — reset
  // whenever the caller asks for a different key (or clears the request).
  const seekRef = useRef({ key: null, attempts: 0, notified: false });

  // Read the list-relative scroll offset + viewport height straight off the
  // DOM (getBoundingClientRect works regardless of the scroller's positioning
  // or any chrome rendered above the list).
  const measureViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    const inner = innerRef.current;
    if (!scroller || !inner) return;
    const scRect = scroller.getBoundingClientRect();
    const inRect = inner.getBoundingClientRect();
    // getBoundingClientRect returns sub-pixel floats; round to integers and
    // compare with a 1px tolerance. Without this, tiny fractional jitter
    // (accumulated fractional row heights, HiDPI/zoom device-pixel rounding)
    // makes the strict `===` below never reach a fixed point, so the
    // per-commit re-pin below setMetrics → re-render → measure loops forever
    // → React #185 "Maximum update depth exceeded" (#1710 regression).
    const scrollTop = Math.round(scRect.top - inRect.top);
    const viewportHeight = scroller.clientHeight;
    setMetrics(prev =>
      Math.abs(prev.scrollTop - scrollTop) < 1 && prev.viewportHeight === viewportHeight
        ? prev
        : { scrollTop, viewportHeight });
  }, [scrollerRef]);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      measureViewport();
    });
  }, [measureViewport]);

  // Listen to the external scroller for scroll + resize.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const onScroll = () => scheduleMeasure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => scheduleMeasure());
      ro.observe(scroller);
    }
    measureViewport();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (ro) ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [scrollerRef, scheduleMeasure, measureViewport]);

  // One shared ResizeObserver watches every mounted row for async size changes
  // (image load, Shiki highlight, expand/collapse). Actual measurement happens
  // synchronously in the layout effect below; here we just request a recompute.
  const rowRO = useRef(null);
  if (rowRO.current === null && typeof ResizeObserver !== 'undefined') {
    rowRO.current = new ResizeObserver(() => setMeasureTick(t => t + 1));
  }
  useLayoutEffect(() => () => { if (rowRO.current) rowRO.current.disconnect(); }, []);

  const getRowRef = (key) => {
    let fn = refCache.current.get(key);
    if (!fn) {
      fn = (el) => {
        const ro = rowRO.current;
        if (el) {
          rowEls.current.set(key, el);
          if (ro) ro.observe(el);
        } else {
          const prev = rowEls.current.get(key);
          if (prev && ro) ro.unobserve(prev);
          rowEls.current.delete(key);
          refCache.current.delete(key);
        }
      };
      refCache.current.set(key, fn);
    }
    return fn;
  };

  // After every commit: measure the mounted rows and the viewport. Running in a
  // layout effect (before paint) means the spacer heights are correct before
  // the caller's own auto-scroll effect fires, so "stick to bottom" still lands
  // on the true bottom.
  useLayoutEffect(() => {
    let changed = false;
    for (const [key, el] of rowEls.current) {
      const h = el.offsetHeight + gap;
      if (h > gap && heightsRef.current.get(key) !== h) {
        heightsRef.current.set(key, h);
        changed = true;
      }
    }
    measureViewport();
    // Re-assert "bottom" after measuring. On initial load / room switch the
    // rendered window starts at the top, so the rows below the fold are all
    // estimates and the caller's `scrollTop = scrollHeight` landed short of the
    // true bottom; as those rows scroll into view here and are measured the
    // total height grows, so we push scrollTop to the (now larger) scrollHeight
    // and re-measure so the window recomputes toward the bottom. Repeating this
    // per commit converges on the newest message — and keeps the view pinned as
    // a streamed reply grows — without reintroducing full-list rendering. The
    // caller only sets `stickToBottom` while the user is at the bottom, so a
    // deliberate scroll-up (or older-history restore) is never overridden.
    if (stickToBottom && !scrollToKey) {
      const scroller = scrollerRef.current;
      if (scroller) {
        // Only re-pin while we are still measurably short of the bottom. The
        // distance-to-bottom strictly shrinks as off-screen rows mount and are
        // measured, so this terminates at ≤1px — a hard bound on the
        // re-pin → measureViewport → setMetrics → re-render loop. Writing
        // scrollTop unconditionally every commit (and always re-measuring)
        // could otherwise never settle on a sub-pixel/fractional layout and
        // exceed React's update-depth limit (#185).
        const maxTop = scroller.scrollHeight - scroller.clientHeight;
        if (maxTop - scroller.scrollTop > 1) {
          scroller.scrollTop = scroller.scrollHeight;
          measureViewport();
        }
      }
    }

    // #2310: center `scrollToKey` in the viewport, converging over commits as
    // its (initially estimated) row is pulled into the window and measured.
    // See the prop doc above for why this mirrors the stickToBottom loop.
    if (scrollToKey) {
      if (seekRef.current.key !== scrollToKey) {
        seekRef.current = { key: scrollToKey, attempts: 0, notified: false };
      }
      const seek = seekRef.current;
      const scroller = scrollerRef.current;
      if (!seek.notified && scroller) {
        const idx = items.findIndex((it, i) => keyOf(it, i) === scrollToKey);
        if (idx >= 0) {
          const heightsNow = items.map((it, i) => {
            const h = heightsRef.current.get(keyOf(it, i));
            return typeof h === 'number' ? h : estimateHeight + gap;
          });
          const offsetsNow = prefixOffsets(heightsNow);
          const desired = computeCenteredScrollTop({
            offsets: offsetsNow,
            heights: heightsNow,
            index: idx,
            viewportHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight,
          });
          const isMeasured = heightsRef.current.has(keyOf(items[idx], idx));
          const closeEnough = Math.abs(scroller.scrollTop - desired) <= 1;
          seek.attempts += 1;
          // Bounded so a layout that never quite settles (fractional heights,
          // a row that keeps resizing) still resolves the request rather than
          // holding the caller's highlight in limbo forever.
          if ((isMeasured && closeEnough) || seek.attempts > 40) {
            seek.notified = true;
            onScrolledToKey && onScrolledToKey(scrollToKey);
          } else if (!closeEnough) {
            scroller.scrollTop = desired;
            measureViewport();
          }
        }
        // idx < 0: the target isn't in `items` yet (still backfilling) — leave
        // the seek pending; it re-evaluates on the next commit once `items`
        // includes it, or the caller drops `scrollToKey` and gives up.
      }
    } else if (seekRef.current.key !== null) {
      seekRef.current = { key: null, attempts: 0, notified: false };
    }

    if (changed) setMeasureTick(t => t + 1);
  });

  const heights = items.map((it, i) => {
    const h = heightsRef.current.get(keyOf(it, i));
    return typeof h === 'number' ? h : estimateHeight + gap;
  });

  const win = computeWindow({
    heights,
    scrollTop: metrics.scrollTop,
    viewportHeight: metrics.viewportHeight,
    overscan,
  });

  const rows = [];
  for (let i = win.startIndex; i < win.endIndex; i++) {
    const it = items[i];
    const key = keyOf(it, i);
    rows.push(
      <div
        key={key}
        ref={getRowRef(key)}
        style={gap ? { marginBottom: gap, ...rowStyle } : rowStyle}
      >
        {renderItem(it, i)}
      </div>,
    );
  }

  return (
    <div ref={innerRef} style={{ position: 'relative' }}>
      <div style={{ height: win.topPad }} aria-hidden="true" />
      {rows}
      <div style={{ height: win.bottomPad }} aria-hidden="true" />
    </div>
  );
}
