import React, { useState, useMemo, useCallback } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * DataTable — Reusable table with sort, filter, pagination.
 *
 * Props:
 *   columns     — Array of { key, label, sortable?, align?, render? }
 *   data        — Array of row objects
 *   pageSize    — Rows per page (default 10)
 *   onRowClick  — Optional (row) => void
 *   emptyText   — Shown when data is empty
 */
export default function DataTable({
  columns = [],
  data = [],
  pageSize = 10,
  onRowClick,
  onRowDoubleClick,
  emptyText = 'No data found',
}) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');

  /* ── Filter ──────────────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    if (!filter.trim()) return data;
    const q = filter.toLowerCase();
    return data.filter(row =>
      columns.some(col => {
        const val = row[col.key];
        return val != null && String(val).toLowerCase().includes(q);
      })
    );
  }, [data, filter, columns]);

  /* ── Sort ─────────────────────────────────────────────────────────── */
  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  /* ── Paginate ────────────────────────────────────────────────────── */
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageData = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  /* ── Sort toggle ─────────────────────────────────────────────────── */
  const toggleSort = useCallback((key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  }, [sortKey]);

  const cellStyle = (col) => ({
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    textAlign: col.align || 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-3)',
        borderBottom: '1px solid var(--eb-border-default)',
      }}>
        <input
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(0); }}
          placeholder="Filter..."
          style={{
            flex: 1, maxWidth: 280,
            padding: 'var(--eb-space-1) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginLeft: 'auto' }}>
          {sorted.length} {sorted.length === 1 ? 'row' : 'rows'}
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontSize: 'var(--eb-text-base)',
        }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--eb-border-default)' }}>
              {columns.map(col => (
                <th
                  key={col.key}
                  onClick={() => col.sortable !== false && toggleSort(col.key)}
                  style={{
                    ...cellStyle(col),
                    fontWeight: 'var(--eb-font-medium)',
                    fontSize: 'var(--eb-text-sm)',
                    color: 'var(--eb-text-secondary)',
                    cursor: col.sortable !== false ? 'pointer' : 'default',
                    userSelect: 'none',
                    background: 'var(--eb-bg-surface)',
                    position: 'sticky',
                    top: 0,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
                    {col.label}
                    {col.sortable !== false && (
                      sortKey === col.key
                        ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)
                        : <ChevronsUpDown size={14} style={{ opacity: 0.3 }} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    padding: 'var(--eb-space-8)',
                    textAlign: 'center',
                    color: 'var(--eb-text-muted)',
                    fontSize: 'var(--eb-text-sm)',
                  }}
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              pageData.map((row, rowIdx) => (
                <tr
                  key={row.id || rowIdx}
                  onClick={() => onRowClick?.(row)}
                  onDoubleClick={() => onRowDoubleClick?.(row)}
                  style={{
                    borderBottom: '1px solid var(--eb-border-default)',
                    cursor: onRowClick || onRowDoubleClick ? 'pointer' : 'default',
                    transition: 'background var(--eb-transition-fast)',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {columns.map(col => (
                    <td key={col.key} style={cellStyle(col)}>
                      {col.render ? col.render(row[col.key], row) : row[col.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          borderTop: '1px solid var(--eb-border-default)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
        }}>
          <span>
            Showing {safePage * pageSize + 1}-{Math.min((safePage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }}>
            <PaginationBtn onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>
              <ChevronLeft size={14} />
            </PaginationBtn>
            <span style={{ padding: '0 var(--eb-space-2)', lineHeight: '28px' }}>
              {safePage + 1} / {totalPages}
            </span>
            <PaginationBtn onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>
              <ChevronRight size={14} />
            </PaginationBtn>
          </div>
        </div>
      )}
    </div>
  );
}

function PaginationBtn({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28,
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        color: disabled ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
