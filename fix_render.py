import re, sys

# Read the current index.html
with open(r'C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Ready-Leads\public\index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# The old function to replace (find by unique markers)
old_start = 'function renderIndividual(data) {'
old_end_marker = "atomsPanel.parentNode.insertBefore(panel, atomsPanel.nextSibling);\n  }\n}"

# Find the old function
start_idx = content.find(old_start)
if start_idx == -1:
    print("ERROR: Could not find renderIndividual function")
    sys.exit(1)

# Find the closing of the function (the } after insertBefore)
end_search = content.find(old_end_marker, start_idx)
if end_search == -1:
    # Try with \r\n
    old_end_marker2 = "atomsPanel.parentNode.insertBefore(panel, atomsPanel.nextSibling);\r\n  }\r\n}"
    end_search = content.find(old_end_marker2, start_idx)
    if end_search == -1:
        print("ERROR: Could not find end of renderIndividual function")
        sys.exit(1)
    end_idx = end_search + len(old_end_marker2)
else:
    end_idx = end_search + len(old_end_marker)

print(f"Found renderIndividual at chars {start_idx}-{end_idx}")

new_function = r'''function renderIndividual(data) {
  if (!data) return;
  const name = data.target?.name || 'Target Individual';
  const title = data.target?.title || '';
  const company = data.target?.company || '';
  const keyInsight = data.target?.key_insight || '';
  const pitchAngles = data.pitch_angles || [];
  const careerHighlights = data.career_highlights || [];
  const publicSignals = data.public_signals || [];
  const vendorOpinions = data.vendor_opinions || [];
  const leadershipStyle = data.leadership_style || '';
  const painSignals = data.pain_signals || [];
  const atomCount = (data.atoms || []).length;
  const recognized = data.scan?.recognized;
  const confidence = data.scan?.confidence || '';

  const listItems = (items) => items.map(i => `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;line-height:1.5">${esc(i)}</div>`).join('');

  const panel = document.createElement('div');
  panel.className = 'result-panel active';
  panel.id = 'individual-panel';
  panel.innerHTML = `
    <div class="section-title">Individual Intelligence &mdash; ${esc(name)}</div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-top:8px">

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div style="font-size:16px;font-weight:700">${esc(name)}</div>
          ${title || company ? `<div style="font-size:13px;color:var(--text-2)">${esc(title)}${title && company ? ' &mdash; ' : ''}${esc(company)}</div>` : ''}
        </div>
        ${confidence ? `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:4px 10px;border-radius:12px;${recognized ? 'background:rgba(61,220,132,0.12);color:var(--green)' : 'background:rgba(245,158,11,0.12);color:#f59e0b'}">${recognized ? 'Recognized' : 'Inferred'} &middot; ${esc(confidence)}</div>` : ''}
      </div>

      ${keyInsight ? `
      <div style="background:rgba(90,169,255,0.08);border-left:3px solid var(--cyan);padding:10px 14px;border-radius:0 8px 8px 0;margin-bottom:14px">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--cyan);margin-bottom:4px">Key Insight</div>
        <div style="font-size:14px;line-height:1.5">${esc(keyInsight)}</div>
      </div>` : ''}

      <div style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.6">${esc(data.summary || '')}</div>

      ${pitchAngles.length ? `
      <div style="margin-bottom:14px">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--green);margin-bottom:8px">Conversation Openers (${pitchAngles.length})</div>
        ${pitchAngles.map(a => `<div style="background:rgba(61,220,132,0.06);border:1px solid rgba(61,220,132,0.2);border-radius:6px;padding:8px 10px;margin:4px 0;font-size:12px;line-height:1.5">${esc(a)}</div>`).join('')}
      </div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">

        ${careerHighlights.length ? `
        <div>
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--cyan);margin-bottom:8px">Career Highlights (${careerHighlights.length})</div>
          ${listItems(careerHighlights)}
        </div>` : ''}

        ${painSignals.length ? `
        <div>
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#ef4444;margin-bottom:8px">Pain Signals (${painSignals.length})</div>
          ${listItems(painSignals)}
        </div>` : ''}

        ${publicSignals.length ? `
        <div>
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#a78bfa;margin-bottom:8px">Public Signals (${publicSignals.length})</div>
          ${listItems(publicSignals)}
        </div>` : ''}

        ${vendorOpinions.length ? `
        <div>
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#f59e0b;margin-bottom:8px">Vendor Opinions (${vendorOpinions.length})</div>
          ${listItems(vendorOpinions)}
        </div>` : ''}

      </div>

      ${leadershipStyle ? `
      <div style="margin-top:14px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:6px;padding:10px 12px">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#a78bfa;margin-bottom:4px">Leadership Style</div>
        <div style="font-size:12px;line-height:1.5">${esc(leadershipStyle)}</div>
      </div>` : ''}

      <div style="margin-top:12px;font-size:11px;color:var(--dim)">${atomCount} behavioral atoms extracted</div>
    </div>
  `;

  const atomsPanel = $('atoms-panel');
  if (atomsPanel && atomsPanel.parentNode) {
    const existing = document.getElementById('individual-panel');
    if (existing) existing.remove();
    atomsPanel.parentNode.insertBefore(panel, atomsPanel.nextSibling);
  }
}'''

content = content[:start_idx] + new_function + content[end_idx:]

with open(r'C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Ready-Leads\public\index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print(f"SUCCESS: Replaced renderIndividual ({end_idx - start_idx} chars old -> {len(new_function)} chars new)")
