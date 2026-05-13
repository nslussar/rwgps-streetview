// Shared primitives across popup variations
// Progress visualizations, popup frame chrome, etc.

// Tiny SVG progress ring
function ProgressRing({ value = 0, max = 100, size = 56, stroke = 6, color = '#1f6feb', track = '#eef0f3', label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${pct * c} ${c}`}
              transform={`rotate(-90 ${size/2} ${size/2})`} />
      {label && (
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
              fontSize={size * 0.22} fontFamily="Geist Mono, monospace" fontWeight="600" fill="#131418">
          {label}
        </text>
      )}
    </svg>
  );
}

// Segmented bar — used + cached + remaining
function QuotaBar({ used, cached, max, height = 8, radius = 4, palette }) {
  const p = palette || { used: '#1f6feb', cached: '#9bb7e8', track: '#eef0f3' };
  const usedPct = Math.min(100, (used / max) * 100);
  const cachedPct = Math.min(100 - usedPct, (cached / max) * 100);
  return (
    <div style={{ height, background: p.track, borderRadius: radius, overflow: 'hidden', display: 'flex', width: '100%' }}>
      <div style={{ width: `${usedPct}%`, background: p.used }} />
      <div style={{ width: `${cachedPct}%`, background: p.cached, opacity: 0.7 }} />
    </div>
  );
}

// Eye icon for password-like input
function EyeIcon({ off }) {
  return off ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24"/><path d="M10.73 5.08A11 11 0 0 1 12 5c7 0 11 7 11 7a13 13 0 0 1-1.67 2.68"/>
      <path d="M6.61 6.61A13 13 0 0 0 1 12s4 7 11 7a11 11 0 0 0 5.94-1.74"/><line x1="2" y1="2" x2="22" y2="22"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function Caret({ open, size = 10, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
      <path d={`M3 1 L7 5 L3 9`} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalIcon({ size = 12, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2H2v8h8V8M7 2h3v3M5 7l5-5"/>
    </svg>
  );
}

function CopyIcon({ size = 12, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.2"/><path d="M2 8V2h6"/>
    </svg>
  );
}

function CheckIcon({ size = 12, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6.5 L5 9.5 L10 3"/>
    </svg>
  );
}

// Mock chrome browser popup chrome (extension toolbar with the popup hanging off it)
function ChromeBrowserBezel({ children, scale = 1 }) {
  return (
    <div style={{
      width: 460, height: 'auto',
      background: 'linear-gradient(180deg, #2a2c30 0%, #232529 100%)',
      borderRadius: 10,
      padding: '0 0 14px 0',
      boxShadow: '0 12px 40px -10px rgba(0,0,0,0.35)',
    }}>
      {/* tab strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 0' }}>
        <div style={{ width: 10, height: 10, borderRadius: 999, background: '#fa6058' }} />
        <div style={{ width: 10, height: 10, borderRadius: 999, background: '#fdbd2e' }} />
        <div style={{ width: 10, height: 10, borderRadius: 999, background: '#28c93f' }} />
        <div style={{ marginLeft: 12, height: 24, padding: '0 12px', background: '#3a3c41', color: '#dadbde', borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', fontSize: 11, fontFamily: 'Inter Tight', maxWidth: 180, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          ridewithgps.com — Route planner
        </div>
      </div>
      {/* address bar */}
      <div style={{ background: '#3a3c41', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 24, background: '#2c2e32', borderRadius: 12, padding: '0 10px', display: 'flex', alignItems: 'center', fontSize: 10, color: '#a0a3a8', fontFamily: 'Geist Mono, monospace' }}>
          ridewithgps.com/routes/new
        </div>
        {/* extension toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: '#4a4d52', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#cbcdd1' }}>◉</div>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: '#1f6feb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 600 }}>SV</div>
        </div>
      </div>
      {/* popup hangs off */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 10px 0' }}>
        <div style={{ position: 'relative', marginRight: 18 }}>
          {/* notch */}
          <div style={{ position: 'absolute', top: -6, right: 18, width: 12, height: 12, background: '#fff', transform: 'rotate(45deg)', boxShadow: '-1px -1px 2px rgba(0,0,0,0.04)' }} />
          {children}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ProgressRing, QuotaBar, EyeIcon, Caret, ExternalIcon, CopyIcon, CheckIcon, ChromeBrowserBezel });
