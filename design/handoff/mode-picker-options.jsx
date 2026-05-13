// Mode picker — 4 options to make the choice feel like distinct functional paths

const MP_BLUE = '#1f6feb';
const MP_BLUE_LIGHT = '#dbe7fb';
const MP_BLUE_BORDER = '#1f6feb';
const MP_INK = '#131418';
const MP_DIM = '#6a6f7a';
const MP_LINE = '#eef0f3';
const MP_SURFACE = '#fff';

// A — Current style, but selected is bright blue
function ModePickerA({ active = 'apikey' }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2,
      padding: 2, background: '#f1f3f7', borderRadius: 8
    }}>
      {[
        { id: 'experimental', label: 'Experimental', sub: 'No API key' },
        { id: 'apikey', label: 'API key', sub: 'Full coverage' },
      ].map(m => {
        const isActive = active === m.id;
        return (
          <div key={m.id} style={{
            padding: '8px 10px', borderRadius: 6,
            background: isActive ? MP_BLUE : 'transparent',
            color: isActive ? '#fff' : MP_DIM,
            fontSize: 13, fontWeight: isActive ? 600 : 500,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            cursor: 'pointer'
          }}>
            <span>{m.label}</span>
            <span style={{ fontSize: 11, color: isActive ? '#dbe7fb' : '#a0a4ad', fontWeight: 400 }}>{m.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

// B — Two big horizontal cards, selected has bright blue tint + border
function ModePickerB({ active = 'apikey' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {[
        { id: 'experimental', label: 'Experimental', sub: 'No API key needed', icon: '⚡' },
        { id: 'apikey', label: 'API key', sub: 'Full coverage', icon: '🔑' },
      ].map(m => {
        const isActive = active === m.id;
        return (
          <div key={m.id} style={{
            padding: '12px',
            border: `1.5px solid ${isActive ? MP_BLUE : '#e6e8ec'}`,
            borderRadius: 8,
            background: isActive ? '#f3f7fe' : '#fff',
            cursor: 'pointer',
            position: 'relative'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <RadioDot active={isActive} />
              <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? MP_BLUE : MP_INK }}>{m.label}</span>
            </div>
            <div style={{ fontSize: 12, color: MP_DIM, paddingLeft: 22 }}>{m.sub}</div>
          </div>
        );
      })}
    </div>
  );
}

// C — Vertical radio cards stacked, richer detail
function ModePickerC({ active = 'apikey' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[
        { id: 'experimental', label: 'Experimental', desc: 'Uses the Maps JS panorama endpoint. No setup, no quota. May miss some user-contributed photospheres.' },
        { id: 'apikey', label: 'API key', desc: 'Street View Static API. Full coverage including user photospheres. 10,000 free requests/month.' },
      ].map(m => {
        const isActive = active === m.id;
        return (
          <div key={m.id} style={{
            padding: '12px 14px',
            border: `1.5px solid ${isActive ? MP_BLUE : '#e6e8ec'}`,
            borderRadius: 8,
            background: isActive ? '#f3f7fe' : '#fff',
            cursor: 'pointer',
            display: 'flex', gap: 10
          }}>
            <div style={{ paddingTop: 1 }}><RadioDot active={isActive} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: isActive ? MP_BLUE : MP_INK, marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 12, color: MP_DIM, lineHeight: 1.5 }}>{m.desc}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// D — Segmented control with strong blue active + chip-style
function ModePickerD({ active = 'apikey' }) {
  return (
    <div style={{
      display: 'flex', padding: 3, background: '#f1f3f7', borderRadius: 10, gap: 2
    }}>
      {[
        { id: 'experimental', label: 'Experimental', sub: 'No API key' },
        { id: 'apikey', label: 'API key', sub: 'Full coverage' },
      ].map(m => {
        const isActive = active === m.id;
        return (
          <div key={m.id} style={{
            flex: 1,
            padding: '10px 12px', borderRadius: 7,
            background: isActive ? MP_BLUE : 'transparent',
            color: isActive ? '#fff' : MP_DIM,
            fontSize: 13, fontWeight: isActive ? 600 : 500,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
            cursor: 'pointer',
            boxShadow: isActive ? '0 1px 2px rgba(31,111,235,0.3)' : 'none'
          }}>
            <span>{m.label}</span>
            <span style={{ fontSize: 11, color: isActive ? '#cfe0fb' : '#a0a4ad', fontWeight: 400 }}>{m.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

function RadioDot({ active }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: 999,
      border: `1.5px solid ${active ? MP_BLUE : '#c9cdd5'}`,
      background: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
    }}>
      {active && <div style={{ width: 8, height: 8, borderRadius: 999, background: MP_BLUE }} />}
    </div>
  );
}

function MockPopup({ children, label, desc }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: MP_INK }}>{label}</div>
        <div style={{ fontSize: 12, color: MP_DIM, marginTop: 2 }}>{desc}</div>
      </div>
      <div className="popup" style={{ width: 380, background: '#fff', fontFamily: 'inherit' }}>
        {/* Header */}
        <div style={{ padding: '16px 16px 16px 18px', borderBottom: `1px solid ${MP_LINE}`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="icon128.png" width="26" height="26" alt="" />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Street View Preview</span>
          </div>
        </div>
        {/* Body w/ mode picker */}
        <div style={{ padding: 16 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ModePickerExplorations() {
  return (
    <div style={{
      padding: 28, fontFamily: "'Inter', system-ui, sans-serif",
      background: `radial-gradient(circle at 1px 1px, rgba(0,0,0,0.06) 1px, transparent 0) 0 0 / 16px 16px, #faf9f6`,
      minHeight: '100vh'
    }}>
      <div style={{ maxWidth: 920, margin: '0 auto 24px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.08, textTransform: 'uppercase', color: MP_DIM }}>Mode picker · functional path</div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, letterSpacing: -0.01 }}>Four ways to make the choice feel real</div>
        <div style={{ fontSize: 13, color: '#33363d', marginTop: 8, lineHeight: 1.55, maxWidth: 620 }}>
          All show API key mode selected. Bright blue is the same accent as elsewhere.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 28, maxWidth: 920, margin: '0 auto' }}>
        <MockPopup label="A · Bright-blue pill" desc="Smallest change. Active option fills with bright blue.">
          <ModePickerA active="apikey" />
        </MockPopup>
        <MockPopup label="B · Two cards (radio)" desc="Cards with radio dots. Active = blue border + tint.">
          <ModePickerB active="apikey" />
        </MockPopup>
        <MockPopup label="C · Vertical detail cards" desc="Stacked, with a sentence of detail per option. Most committal.">
          <ModePickerC active="apikey" />
        </MockPopup>
        <MockPopup label="D · Segmented bright-blue" desc="Like A but bigger, with left-aligned text + soft shadow on active.">
          <ModePickerD active="apikey" />
        </MockPopup>
      </div>
    </div>
  );
}

window.ModePickerExplorations = ModePickerExplorations;
