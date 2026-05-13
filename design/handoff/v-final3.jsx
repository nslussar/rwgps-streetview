// V-Final 3 — adds experimental mode, enable toggle, verbose logging
// Mode picker (segmented) · enable status row · advanced now houses debug

function VFinal3Popup({ state = 'apikey_active', mode = 'apikey', enabled = true, toggleVariant = 'header' }) {
  const [showKey, setShowKey] = React.useState(false);
  const [help, setHelp] = React.useState(false);
  const [activeMode, setActiveMode] = React.useState(mode);
  const [isEnabled, setIsEnabled] = React.useState(enabled);

  // Single section open at a time (accordion). Defaults vary by mode.
  const defaultOpen =
    state === 'apikey_expanded' ? 'advanced' :
    activeMode === 'apikey' && state !== 'firstrun' ? 'usage' :
    null;
  const [openSection, setOpenSection] = React.useState(defaultOpen);
  const toggleSection = (id) => setOpenSection(openSection === id ? null : id);

  const used = 1357, cached = 276, geo = 1494, max = 10000;
  const usedPct = used / max * 100;
  const isFirstRun = state === 'firstrun';

  const accent = '#1f6feb';
  const ink = '#131418';
  const dim = '#6a6f7a';
  const line = '#eef0f3';

  // Dimmer everything if disabled (except header + toggle itself)
  const bodyOpacity = isEnabled ? 1 : 0.4;
  const bodyPointer = isEnabled ? 'auto' : 'none';

  return (
    <div className="popup" style={{ width: 380, fontSize: 14, fontFamily: "'Inter', system-ui, sans-serif", color: ink }}>
      {/* Consolidated header — icon + name + toggle in one row */}
      <div style={{ padding: '16px 16px 16px 18px', borderBottom: `1px solid ${line}`, display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="icon128.png" width="26" height="26" style={{ display: 'block', flexShrink: 0 }} alt="" />
        <div style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Street View Preview</span>
          <span style={{ fontSize: 12, color: dim, fontVariantNumeric: 'tabular-nums' }}>(dev)</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flexShrink: 0 }} title={isEnabled ? 'Click to disable (S)' : 'Click to enable (S)'}>
          <Switch on={isEnabled} onChange={() => setIsEnabled(!isEnabled)} accent={accent} />
          <kbd style={{
            display: 'inline-block', padding: '1px 6px', borderRadius: 4,
            border: '1px solid #d6d9de', background: '#fafbfc',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: '#6a6f7a',
            boxShadow: '0 1px 0 #e6e8ec'
          }}>S</kbd>
        </label>
      </div>

      <div style={{ opacity: bodyOpacity, pointerEvents: bodyPointer }}>

        {/* Mode picker — selected expanded, other collapsed (option B) */}
        <div style={{ padding: '14px 16px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { id: 'experimental', label: 'Experimental', short: 'no API key', desc: 'No API key needed. Bike trail coverage is limited.' },
              { id: 'apikey', label: 'Bring your own API key', short: 'better coverage', desc: 'Better bike trail coverage. 10,000 free requests / month.' },
            ].map(m => {
              const isActive = activeMode === m.id;
              return isActive ? (
                <button key={m.id} onClick={() => setActiveMode(m.id)} aria-pressed={true} style={{
                  padding: '10px 12px',
                  border: `1.5px solid ${accent}`,
                  borderRadius: 8,
                  background: '#f3f7fe',
                  cursor: 'pointer',
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  textAlign: 'left',
                  fontFamily: 'inherit', color: 'inherit',
                  width: '100%',
                  transition: 'border-color 120ms, background 120ms'
                }}>
                  <div style={{ paddingTop: 2 }}>
                    <ModeRadio active={true} accent={accent} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: accent, marginBottom: 2 }}>{m.label}</div>
                    <div style={{ fontSize: 13, color: dim, lineHeight: 1.45 }}>{m.desc}</div>
                  </div>
                </button>
              ) : (
                <button key={m.id} onClick={() => setActiveMode(m.id)} aria-pressed={false} style={{
                  padding: '8px 12px',
                  border: '1.5px solid #e6e8ec',
                  borderRadius: 8,
                  background: '#fff',
                  cursor: 'pointer',
                  display: 'flex', gap: 10, alignItems: 'center',
                  textAlign: 'left',
                  fontFamily: 'inherit', color: 'inherit',
                  width: '100%',
                  transition: 'border-color 120ms, background 120ms'
                }}>
                  <ModeRadio active={false} accent={accent} />
                  <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{m.label}</span>
                  <span style={{ fontSize: 13, color: dim }}>{m.short}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* First-run hint removed — descriptive text is now in the cards */}

        {/* Body — mode-dependent */}
        {activeMode === 'experimental' ? (
          <ExperimentalBody isFirstRun={isFirstRun} accent={accent} ink={ink} dim={dim} line={line}
            openSection={openSection} toggleSection={toggleSection} />
        ) : (
          <ApiKeyBody
            isFirstRun={isFirstRun}
            used={used} cached={cached} geo={geo} max={max} usedPct={usedPct}
            help={help} setHelp={setHelp}
            showKey={showKey} setShowKey={setShowKey}
            openSection={openSection} toggleSection={toggleSection}
            accent={accent} ink={ink} dim={dim} line={line}
          />
        )}

      </div>
    </div>
  );
}

// — Switch component (toggle) —
function ModeRadio({ active, accent }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: 999,
      border: `1.5px solid ${active ? accent : '#c9cdd5'}`,
      background: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
    }}>
      {active && <div style={{ width: 8, height: 8, borderRadius: 999, background: accent }} />}
    </div>
  );
}

function Switch({ on, onChange, accent }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      style={{
        width: 36, height: 20, padding: 0, border: 'none',
        background: on ? accent : '#c9cdd5',
        borderRadius: 999, position: 'relative', cursor: 'pointer',
        transition: 'background 150ms', flexShrink: 0
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 18 : 2,
        width: 16, height: 16, borderRadius: 999, background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 150ms'
      }} />
    </button>
  );
}

// — Experimental mode body —
function ExperimentalBody({ isFirstRun, accent, ink, dim, line, openSection, toggleSection }) {
  return (
    <div style={{ padding: 16 }}>
      <AdvancedSection
        open={openSection === 'advanced'}
        onToggle={() => toggleSection('advanced')}
        ink={ink} dim={dim} line={line}
        marginTop={0}
      />
    </div>
  );
}

// — API key mode body —
function ApiKeyBody({
  isFirstRun, used, cached, geo, max, usedPct,
  help, setHelp,
  showKey, setShowKey,
  openSection, toggleSection,
  accent, ink, dim, line
}) {
  const noKey = isFirstRun; // first-run + api key mode = needs onboarding
  const usageExpanded = openSection === 'usage';
  const keyExpanded = openSection === 'apikey';

  return (
    <div style={{ padding: 16 }}>
      {noKey ? (
        // Onboarding card
        <div>
          <div style={{
            background: 'linear-gradient(180deg, #f7f9fc 0%, #f1f4f9 100%)',
            border: '1px dashed #c9cdd5', borderRadius: 12, padding: 18, textAlign: 'center'
          }}>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6, letterSpacing: -0.01 }}>Paste your Google Maps API key</div>
            <div style={{ fontSize: 13, color: dim, lineHeight: 1.5, marginBottom: 14 }}>
              The Street View Static API gives you<br />10,000 free requests every month.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input placeholder="AIza..." aria-label="Google Maps API key" style={{
                flex: 1, height: 38, padding: '0 12px', borderRadius: 8,
                border: '1px solid #d6d9de', background: '#fff', fontSize: 14, fontFamily: 'inherit'
              }} />
              <button style={{
                height: 38, padding: '0 16px', borderRadius: 8, border: 'none',
                background: accent, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit'
              }}>Save</button>
            </div>
          </div>
          <button onClick={() => setHelp(!help)} aria-expanded={help} style={{
            marginTop: 14, width: '100%', border: 'none', background: 'none', padding: 0, color: accent,
            fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            cursor: 'pointer', fontFamily: 'inherit'
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Caret open={help} color={accent} /> How to get an API key
            </span>
            <span style={{ fontSize: 13, color: dim, fontWeight: 400 }}>3 min</span>
          </button>
          {help && (
            <ol style={{ margin: '10px 0 0', padding: '12px 16px 12px 32px', fontSize: 13, color: '#33363d', lineHeight: 1.7, background: '#f7f9fc', borderRadius: 8 }}>
              <li>Open <a href="#" style={{ color: accent, fontWeight: 500 }}>Google Cloud Console <ExternalIcon /></a></li>
              <li>Create or select a project</li>
              <li>Enable <b>Street View Static API</b></li>
              <li>Credentials → Create credentials → API key</li>
              <li>Restrict to Street View Static (recommended)</li>
              <li>Copy &amp; paste the key above</li>
            </ol>
          )}
        </div>
      ) : (
        <>
          {/* Google Maps API — usage + cap + key, all under one disclosure */}
          <div>
            <button onClick={() => toggleSection('usage')} aria-expanded={usageExpanded} style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              border: 'none', background: 'none', padding: '10px 0',
              color: ink, fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit'
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Caret open={usageExpanded} /> Google Maps API
              </span>
              <span style={{ fontSize: 13, color: dim, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: used / max > 0.9 ? '#d97706' : '#33363d' }}>{used.toLocaleString()}</span>
                <span> / {max.toLocaleString()}</span>
              </span>
            </button>
            {usageExpanded && (
              <div style={{ paddingTop: 6, paddingBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontSize: 13, color: dim, fontWeight: 500 }}>May 2026</div>
                  <button style={{ border: 'none', background: 'none', padding: 0, color: accent, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>Reset</button>
                </div>
                <div style={{ height: 10, background: line, borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${usedPct}%`, height: '100%', background: used / max > 0.9 ? '#d97706' : accent }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: dim }}>
                  <span>0</span>
                  <span>{max / 1000}k</span>
                </div>
                <div style={{ marginTop: 12, fontSize: 13, color: dim, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Served from cache</span>
                  <span style={{ color: '#33363d', fontVariantNumeric: 'tabular-nums' }}>{cached.toLocaleString()}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 13, color: dim, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Geocoding (separate quota)</span>
                  <span style={{ color: '#33363d', fontVariantNumeric: 'tabular-nums' }}>{geo.toLocaleString()}</span>
                </div>
                <div style={{ marginTop: 10, padding: '8px 12px', background: '#f7f9fc', border: `1px solid ${line}`, borderRadius: 8, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#33363d', fontWeight: 500 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: '#22c55e' }} />
                    Active on this page
                  </span>
                  <span style={{ color: dim, fontVariantNumeric: 'tabular-nums' }}>14 sv · 1 cached · 0 geo</span>
                </div>

                {/* Cap row */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, paddingTop: 12, marginTop: 12, borderTop: `1px solid ${line}` }}>
                  <input type="checkbox" defaultChecked style={{ accentColor: accent, width: 14, height: 14 }} />
                  <span style={{ flex: 1 }}>Enforce monthly cap of</span>
                  <input defaultValue="10000" style={{ width: 80, height: 30, padding: '0 8px', borderRadius: 6, border: '1px solid #d6d9de', fontSize: 14, fontFamily: 'inherit', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                </label>

                {/* API key row */}
                <div style={{ paddingTop: 12, marginTop: 12, borderTop: `1px solid ${line}` }}>
                  <div style={{ fontSize: 13, color: dim, fontWeight: 500, marginBottom: 6 }}>API key</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    height: 32, padding: '0 10px', borderRadius: 6,
                    border: '1px solid #e6e8ec', background: '#fafbfc'
                  }}>
                    <span style={{ flex: 1, fontSize: 13, color: '#33363d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', letterSpacing: 0.04 }}>
                      {showKey ? 'EXAMPLE-NOT-A-REAL-KEY-FOR-DEMO-ONLY-XX' : '••••••••••••••••••••••••••••••'}
                    </span>
                    <button onClick={() => setShowKey(!showKey)} aria-label={showKey ? 'Hide key' : 'Show key'} style={{ border: 'none', background: 'none', color: dim, cursor: 'pointer', padding: 4, display: 'flex' }}>
                      <EyeIcon off={showKey} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <AdvancedSection
        open={openSection === 'advanced'}
        onToggle={() => toggleSection('advanced')}
        ink={ink} dim={dim} line={line} marginTop={14}
      />
    </div>
  );
}

// — Advanced section, with verbose logging at bottom —
function AdvancedSection({ open, onToggle, ink, dim, line, marginTop = 14 }) {
  return (
    <div>
      <button onClick={onToggle} aria-expanded={open} style={{
        marginTop, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        border: 'none', background: 'none', padding: '10px 0', borderTop: `1px solid ${line}`,
        color: ink, fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Caret open={open} /> Advanced
        </span>
      </button>
      {open && (
        <div style={{ paddingTop: 6, paddingBottom: 4 }}>
          {/* Debug first */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer', paddingBottom: 12, borderBottom: `1px dashed ${line}`, marginBottom: 14 }}>
            <input type="checkbox" style={{ accentColor: '#1f6feb', width: 14, height: 14 }} />
            <span style={{ flex: 1 }}>Enable debug logging</span>
          </label>
          {/* Tuning grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {[
              ['Pano radius', 'm', 10, 'How far Google searches around the point.'],
              ['Position rounding', 'm', 25, 'Snap nearby positions to reuse cached images.'],
              ['Min cursor move', 'm', 25, 'Distance threshold before refetching.'],
              ['Settle delay', 'ms', 100, 'Wait for cursor to stop before fetching.'],
            ].map(([label, unit, val, hint]) => (
              <div key={label}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  {label} <span style={{ color: dim, fontWeight: 400 }}>({unit})</span>
                </div>
                <input defaultValue={val} style={{ width: '100%', height: 32, padding: '0 8px', borderRadius: 6, border: '1px solid #d6d9de', fontSize: 14, fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }} />
                <div style={{ fontSize: 13, color: dim, marginTop: 4, lineHeight: 1.4 }}>{hint}</div>
              </div>
            ))}
          </div>
          {/* Reset all link — only shown when at least one setting differs from default */}
          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <button style={{
              border: 'none', background: 'none', color: '#1f6feb', padding: 0,
              cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 5
            }}>
              <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 6.5a4.5 4.5 0 1 1-1.5-3.4M11 1v3h-3"/>
              </svg>
              Reset all to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

window.VFinal3Popup = VFinal3Popup;
