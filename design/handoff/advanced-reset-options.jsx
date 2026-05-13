// Advanced reset options — 4 variants for resetting settings
// Each shows the Advanced section in an isolated panel with some fields modified.

const DEFAULTS = { panoRadius: 10, posRound: 25, minMove: 25, settle: 100 };
const MODIFIED = { panoRadius: 20, posRound: 25, minMove: 50, settle: 100 };
// Pano radius and min move are modified; pos round and settle are at default.

function Field({ label, unit, value, isDefault, defaultVal, variant }) {
  const dim = '#6a6f7a';
  const accent = '#1f6feb';
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{label} <span style={{ color: dim, fontWeight: 400 }}>({unit})</span></span>
        {variant === 'badge' && !isDefault && (
          <span style={{ fontSize: 10, color: '#854d0e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, padding: '0 5px', fontWeight: 500 }}>modified</span>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <input defaultValue={value} style={{
          width: '100%', height: 30, padding: variant === 'inline' && !isDefault ? '0 28px 0 8px' : '0 8px',
          borderRadius: 6, border: `1px solid ${variant !== 'none' && !isDefault ? '#d97706' : '#d6d9de'}`,
          fontSize: 13, fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
          background: variant !== 'none' && !isDefault ? '#fffbeb' : '#fff',
          color: '#131418'
        }} />
        {variant === 'inline' && !isDefault && (
          <button title={`Reset to default (${defaultVal})`} style={{
            position: 'absolute', right: 4, top: 4, height: 22, width: 22,
            border: 'none', background: 'none', color: dim, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4
          }}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 6.5a4.5 4.5 0 1 1-1.5-3.4M11 1v3h-3"/>
            </svg>
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: dim, marginTop: 4, lineHeight: 1.4 }}>
        {variant === 'hintreset' && !isDefault ? (
          <>Default: <button style={{ border: 'none', background: 'none', color: accent, padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>{defaultVal}{` `}↺</button></>
        ) : variant === 'hintreset' ? (
          <>Default: {defaultVal}</>
        ) : (
          <>How far Google searches.</>
        )}
      </div>
    </div>
  );
}

function AdvancedPanel({ variant, title, desc, values }) {
  const dim = '#6a6f7a';
  const ink = '#131418';
  const line = '#eef0f3';
  const accent = '#1f6feb';
  const fields = [
    { label: 'Pano radius', unit: 'm', value: values.panoRadius, defaultVal: DEFAULTS.panoRadius },
    { label: 'Position rounding', unit: 'm', value: values.posRound, defaultVal: DEFAULTS.posRound },
    { label: 'Min cursor move', unit: 'm', value: values.minMove, defaultVal: DEFAULTS.minMove },
    { label: 'Settle delay', unit: 'ms', value: values.settle, defaultVal: DEFAULTS.settle },
  ];
  const anyModified = fields.some(f => f.value !== f.defaultVal);
  return (
    <div className="popup" style={{
      width: 360, padding: '14px 16px 16px', fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: 13, color: ink, background: '#fff', borderRadius: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.06, textTransform: 'uppercase', color: dim, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: dim, lineHeight: 1.5, marginBottom: 14 }}>{desc}</div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 10, borderBottom: `1px solid ${line}`, marginBottom: 14 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}>
          <Caret open={true} /> Advanced
        </span>
        {variant === 'bottomlink' || variant === 'header' ? null : null}
        {variant === 'header' && anyModified && (
          <button style={{
            border: 'none', background: 'none', color: accent, padding: 0,
            cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit'
          }}>Reset to defaults</button>
        )}
      </div>

      {/* debug row first */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', paddingBottom: 12, borderBottom: `1px dashed ${line}`, marginBottom: 14 }}>
        <input type="checkbox" style={{ accentColor: accent, width: 14, height: 14 }} />
        <span style={{ flex: 1 }}>Enable debug logging</span>
      </label>

      {/* fields */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {fields.map(f => (
          <Field key={f.label}
            label={f.label} unit={f.unit} value={f.value}
            isDefault={f.value === f.defaultVal}
            defaultVal={f.defaultVal}
            variant={variant === 'none' ? 'none' : variant === 'bottomlink' ? 'none' : variant === 'header' ? 'badge' : variant === 'inline' ? 'inline' : 'hintreset'}
          />
        ))}
      </div>

      {/* footer reset */}
      {variant === 'bottomlink' && anyModified && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${line}`, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={{
            border: 'none', background: 'none', color: accent, padding: 0,
            cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 5
          }}>
            <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 6.5a4.5 4.5 0 1 1-1.5-3.4M11 1v3h-3"/>
            </svg>
            Reset all to defaults
          </button>
        </div>
      )}
    </div>
  );
}

function AdvancedResetExplorations() {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24, padding: 28,
      fontFamily: "'Inter', system-ui, sans-serif",
      background:
        `radial-gradient(circle at 1px 1px, rgba(0,0,0,0.06) 1px, transparent 0) 0 0 / 16px 16px, #faf9f6`,
    }}>
      <AdvancedPanel variant="bottomlink"
        title="A · Bottom link"
        desc="Single 'Reset all' link below the fields, only when something is modified."
        values={MODIFIED} />
      <AdvancedPanel variant="header"
        title="B · Header link + 'modified' badge"
        desc="Reset link in the disclosure row. Modified fields show an amber badge + tint."
        values={MODIFIED} />
      <AdvancedPanel variant="inline"
        title="C · Per-field reset icon"
        desc="Small ↺ icon inside each modified field. Click to reset that one. Field also tints amber."
        values={MODIFIED} />
      <AdvancedPanel variant="hintreset"
        title="D · Default in hint, clickable"
        desc="Hint always shows the default. When modified, the default value is a clickable link to reset."
        values={MODIFIED} />
    </div>
  );
}

window.AdvancedResetExplorations = AdvancedResetExplorations;
