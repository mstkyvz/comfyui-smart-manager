/**
 * Snapshot Paneli
 * Workflow versiyonlarını kaydet, listele, geri yükle, karşılaştır.
 */

import { apiGet, apiPost, apiDelete, getCurrentWorkflow, timeAgo, notify } from "./panel.js";
import { app } from "../../scripts/app.js";

let _snapshots  = [];
let _diffSelect = null;  // diff için seçili snapshot

export function mount(pane) {
  pane.innerHTML = `
    <div class="sm-search" style="gap:6px">
      <input type="text" id="snap-name" placeholder="Snapshot adı…" style="flex:2">
      <select id="snap-project" style="flex:1;min-width:80px;background:#0a0a1a;border:1px solid #2a2a40;border-radius:6px;color:#d0d0e8;padding:6px 8px;font-size:12px;outline:none">
        <option value="default">default</option>
      </select>
      <button class="sm-btn sm-btn-success" id="snap-save">💾 Kaydet</button>
    </div>
    <div class="sm-scroll" id="snap-list">
      <div class="sm-empty sm-loading">Yükleniyor</div>
    </div>
    <div class="sm-footer">
      <button class="sm-btn sm-btn-ghost" id="snap-refresh">↻ Yenile</button>
      <span id="snap-info" style="font-size:10px;color:#444466;flex:1;text-align:right"></span>
    </div>
  `;

  pane.querySelector("#snap-save").onclick    = () => saveSnapshot(pane);
  pane.querySelector("#snap-refresh").onclick = () => loadSnapshots(pane);

  loadSnapshots(pane);
  loadProjects(pane);
}

async function loadProjects(pane) {
  try {
    const projects = await apiGet("/smart_manager/snapshot_projects");
    const sel = pane.querySelector("#snap-project");
    sel.innerHTML = `<option value="default">default</option>` +
      projects.filter(p => p !== "default").map(p => `<option value="${p}">${p}</option>`).join("");
  } catch(e) {}
}

async function loadSnapshots(pane) {
  const list = pane.querySelector("#snap-list");
  list.innerHTML = `<div class="sm-empty sm-loading">Yükleniyor</div>`;
  try {
    _snapshots = await apiGet("/smart_manager/snapshots");
    renderSnapshots(pane);
    pane.querySelector("#snap-info").textContent =
      `${_snapshots.length} snapshot`;
  } catch(e) {
    list.innerHTML = `<div class="sm-empty">Yükleme hatası: ${e.message}</div>`;
  }
}

function renderSnapshots(pane) {
  const list = pane.querySelector("#snap-list");
  if (!_snapshots.length) {
    list.innerHTML = `<div class="sm-empty">Henüz snapshot yok.<br>Workflow'u kaydetmek için 💾 Kaydet'e bas.</div>`;
    return;
  }

  // Projeye göre grupla
  const groups = {};
  for (const s of _snapshots) {
    const p = s.project || "default";
    groups[p] = groups[p] || [];
    groups[p].push(s);
  }

  let html = "";
  for (const [project, snaps] of Object.entries(groups)) {
    html += `<div class="sm-section-title">📁 ${project}</div>`;
    for (const s of snaps) {
      const isDiffSel = _diffSelect === s.id;
      html += `
        <div class="sm-card" id="snap-card-${s.id}" style="border-color:${isDiffSel ? "#5050a0" : "#1e1e38"}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;font-size:12px;word-break:break-word">${s.name}</div>
              <div style="font-size:10px;color:#444466;margin-top:2px">
                ${timeAgo(s.created_at)} · ${s.node_count} node
                ${s.description ? `· <em>${s.description.slice(0,40)}</em>` : ""}
              </div>
              ${s.tags?.length ? `<div style="margin-top:3px">${s.tags.map(t=>`<span class="sm-tag">${t}</span>`).join("")}</div>` : ""}
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0">
              <button class="sm-btn sm-btn-primary snap-restore-btn"   data-id="${s.id}" style="padding:3px 8px;font-size:10px">↩ Yükle</button>
              <button class="sm-btn sm-btn-ghost   snap-diff-btn"      data-id="${s.id}" style="padding:3px 8px;font-size:10px">${isDiffSel ? "✓ Seçili" : "⇄ Diff"}</button>
              <button class="sm-btn sm-btn-danger  snap-delete-btn"    data-id="${s.id}" style="padding:3px 8px;font-size:10px">🗑</button>
            </div>
          </div>
        </div>
      `;
    }
  }

  list.innerHTML = html;

  // Event'ler
  list.querySelectorAll(".snap-restore-btn").forEach(btn => {
    btn.onclick = () => restoreSnapshot(pane, btn.dataset.id);
  });
  list.querySelectorAll(".snap-delete-btn").forEach(btn => {
    btn.onclick = () => deleteSnapshot(pane, btn.dataset.id);
  });
  list.querySelectorAll(".snap-diff-btn").forEach(btn => {
    btn.onclick = () => selectDiff(pane, btn.dataset.id);
  });
}

async function saveSnapshot(pane) {
  const name    = pane.querySelector("#snap-name").value.trim()
    || `Snapshot ${new Date().toLocaleTimeString("tr-TR")}`;
  const project = pane.querySelector("#snap-project").value;
  const wf      = getCurrentWorkflow();

  if (!Object.keys(wf).length) {
    notify("Workflow boş", "error"); return;
  }

  const btn = pane.querySelector("#snap-save");
  btn.disabled = true; btn.textContent = "Kaydediliyor…";

  try {
    const resp = await apiPost("/smart_manager/snapshots", {
      workflow: wf, name, project,
    });
    notify(`✓ "${name}" kaydedildi`, "success");
    pane.querySelector("#snap-name").value = "";
    await loadSnapshots(pane);
  } catch(e) {
    notify(`Hata: ${e.message}`, "error");
  } finally {
    btn.disabled = false; btn.textContent = "💾 Kaydet";
  }
}

async function restoreSnapshot(pane, snapId) {
  try {
    const snap = await apiGet(`/smart_manager/snapshots/${snapId}`);
    const wf   = snap.workflow;
    if (!wf) { notify("Workflow verisi yok", "error"); return; }

    // ComfyUI graph'ını temizle ve yeniden yükle
    app.graph.clear();
    await app.loadGraphData(wf);

    notify(`✓ "${snap.name}" yüklendi`, "success");
  } catch(e) {
    notify(`Yükleme hatası: ${e.message}`, "error");
  }
}

async function deleteSnapshot(pane, snapId) {
  const snap = _snapshots.find(s => s.id === snapId);
  if (!confirm(`"${snap?.name}" silinsin mi?`)) return;

  try {
    await apiDelete(`/smart_manager/snapshots/${snapId}`);
    notify("Snapshot silindi", "info");
    await loadSnapshots(pane);
  } catch(e) {
    notify(`Hata: ${e.message}`, "error");
  }
}

async function selectDiff(pane, snapId) {
  if (_diffSelect && _diffSelect !== snapId) {
    // İkinci seçildi → diff göster
    await showDiff(pane, _diffSelect, snapId);
    _diffSelect = null;
  } else if (_diffSelect === snapId) {
    _diffSelect = null;
    renderSnapshots(pane);
  } else {
    _diffSelect = snapId;
    renderSnapshots(pane);
    notify("Şimdi karşılaştırmak istediğin ikinci snapshot'ı seç", "info");
  }
}

async function showDiff(pane, idA, idB) {
  const list = pane.querySelector("#snap-list");
  list.innerHTML = `<div class="sm-empty sm-loading">Karşılaştırılıyor</div>`;

  try {
    const diff  = await apiGet(`/smart_manager/snapshots/diff/${idA}/${idB}`);
    if (diff.error) { notify(diff.error, "error"); await loadSnapshots(pane); return; }

    const { snapshot_a: a, snapshot_b: b, added, removed, changed, details } = diff;

    list.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;font-weight:600;color:#a0a8ff">Diff Sonucu</span>
        <button class="sm-btn sm-btn-ghost" id="snap-diff-back" style="padding:3px 8px;font-size:10px">← Geri</button>
      </div>
      <div class="sm-card" style="display:flex;gap:12px;font-size:11px">
        <div style="flex:1"><div style="color:#444466">A</div><div style="font-weight:500">${a.name}</div><div style="color:#444466;font-size:10px">${timeAgo(a.created_at)}</div></div>
        <div style="color:#333360;font-size:18px;align-self:center">⇄</div>
        <div style="flex:1"><div style="color:#444466">B</div><div style="font-weight:500">${b.name}</div><div style="color:#444466;font-size:10px">${timeAgo(b.created_at)}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin:8px 0">
        <div class="sm-card" style="flex:1;text-align:center">
          <div style="font-size:20px;color:#4caf7a;font-weight:700">+${added}</div>
          <div style="font-size:10px;color:#444466">Eklenen Node</div>
        </div>
        <div class="sm-card" style="flex:1;text-align:center">
          <div style="font-size:20px;color:#cf6060;font-weight:700">-${removed}</div>
          <div style="font-size:10px;color:#444466">Silinen Node</div>
        </div>
        <div class="sm-card" style="flex:1;text-align:center">
          <div style="font-size:20px;color:#c8b850;font-weight:700">~${changed}</div>
          <div style="font-size:10px;color:#444466">Değişen Node</div>
        </div>
      </div>
      ${details.changed.length ? `
        <div class="sm-section-title">Değişen Node'lar</div>
        ${details.changed.map(n => `
          <div class="sm-card" style="font-size:11px;display:flex;justify-content:space-between">
            <span>${n.class_type || "Node"} #${n.node_id}</span>
            <span class="sm-badge sm-badge-dl">değişti</span>
          </div>`).join("")}
      ` : ""}
    `;

    list.querySelector("#snap-diff-back").onclick = () => loadSnapshots(pane);
  } catch(e) {
    notify(`Diff hatası: ${e.message}`, "error");
    await loadSnapshots(pane);
  }
}
