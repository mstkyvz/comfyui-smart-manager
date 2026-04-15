/**
 * Model Resolver Paneli
 * Workflow'u analiz eder, eksik modelleri gösterir, indirir.
 */

import { apiGet, apiPost, getCurrentWorkflow, formatBytes, notify } from "./panel.js";

let _models   = [];
let _pollTimer = null;

export function mount(pane) {
  pane.innerHTML = `
    <div class="sm-search">
      <button class="sm-btn sm-btn-primary" id="mr-analyze">🔍 Analiz Et</button>
      <button class="sm-btn sm-btn-ghost"   id="mr-local">📁 Tüm Modeller</button>
      <button class="sm-btn sm-btn-success" id="mr-dl-all" disabled>⬇ Hepsini İndir</button>
    </div>
    <div class="sm-scroll" id="mr-list">
      <div class="sm-empty">Analiz Et'e tıklayarak workflow'u tara.</div>
    </div>
    <div class="sm-footer" id="mr-status" style="font-size:11px;color:#444466;">
      Hazır
    </div>
  `;

  pane.querySelector("#mr-analyze").onclick = () => analyzeWorkflow(pane);
  pane.querySelector("#mr-local").onclick   = () => showLocalModels(pane);
  pane.querySelector("#mr-dl-all").onclick  = () => downloadAll(pane);

  // Otomatik analiz
  analyzeWorkflow(pane);
}

async function analyzeWorkflow(pane) {
  const list   = pane.querySelector("#mr-list");
  const status = pane.querySelector("#mr-status");
  list.innerHTML = `<div class="sm-empty sm-loading">Analiz ediliyor</div>`;
  status.textContent = "Workflow taranıyor...";

  try {
    const workflow = getCurrentWorkflow();
    const resp = await apiPost("/smart_manager/analyze", { workflow });
    _models = resp.models || [];

    renderModels(pane);
    const missing = _models.filter(m => !m.exists).length;
    status.textContent = `${_models.length} model tespit edildi${missing ? ` — ${missing} eksik` : " — hepsi mevcut ✓"}`;

    const btn = pane.querySelector("#mr-dl-all");
    btn.disabled = missing === 0;

    if (missing > 0) startPolling(pane);
  } catch (e) {
    list.innerHTML = `<div class="sm-empty">Hata: ${e.message}</div>`;
    status.textContent = "Analiz başarısız.";
  }
}

function renderModels(pane) {
  const list    = pane.querySelector("#mr-list");
  const missing = _models.filter(m => !m.exists);
  const exists  = _models.filter(m => m.exists);

  if (!_models.length) {
    list.innerHTML = `<div class="sm-empty">Bu workflow'da model alanı yok.</div>`;
    return;
  }

  let html = "";

  if (missing.length) {
    html += `<div class="sm-section-title">Eksik (${missing.length})</div>`;
    for (const m of missing) html += modelRow(m);
  }
  if (exists.length) {
    html += `<div class="sm-section-title">Mevcut (${exists.length})</div>`;
    for (const m of exists) html += modelRow(m);
  }

  list.innerHTML = html;

  // Event'ler
  for (const m of missing) {
    const key = mkey(m);
    pane.querySelector(`#mr-find-${key}`)?.addEventListener("click", () => findAndShow(pane, m));
    pane.querySelector(`#mr-dl-${key}`)?.addEventListener("click",   () => startDownload(pane, m));
  }
}

function mkey(m) {
  return (m.folder + "_" + m.name).replace(/[^a-z0-9]/gi, "_");
}

function badgeFor(m) {
  if (m.status === "done")        return `<span class="sm-badge sm-badge-done">✓ İndirildi</span>`;
  if (m.status === "downloading") return `<span class="sm-badge sm-badge-dl">${m.percent || 0}%</span>`;
  if (m.status === "error")       return `<span class="sm-badge sm-badge-error">✗ Hata</span>`;
  if (m.exists)                   return `<span class="sm-badge sm-badge-ok">${formatBytes(m.size_mb)}</span>`;
  return `<span class="sm-badge sm-badge-missing">Eksik</span>`;
}

function modelRow(m) {
  const key    = mkey(m);
  const badge  = badgeFor(m);
  const prog   = (m.status === "downloading")
    ? `<div class="sm-progress-bar"><div class="sm-progress-fill" style="width:${m.percent||0}%"></div></div>`
    : "";

  let actions = "";
  if (!m.exists && !["done","downloading"].includes(m.status)) {
    if (m.url) {
      actions = `<button class="sm-btn sm-btn-success" id="mr-dl-${key}" style="padding:3px 8px;font-size:10px">⬇ İndir</button>`;
    } else {
      actions = `<button class="sm-btn sm-btn-ghost" id="mr-find-${key}" style="padding:3px 8px;font-size:10px">🔍 Ara</button>`;
    }
  }

  return `
    <div class="sm-card" style="display:flex;align-items:flex-start;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-weight:500;font-size:12px;word-break:break-all">${m.name}</span>
          ${badge}
        </div>
        <div style="font-size:10px;color:#444466;margin-top:2px">${m.folder}/</div>
        ${prog}
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">${actions}</div>
    </div>
  `;
}

async function findAndShow(pane, m) {
  const key = mkey(m);
  const btn = pane.querySelector(`#mr-find-${key}`);
  if (btn) { btn.textContent = "..."; btn.disabled = true; }

  try {
    const resp = await apiPost("/smart_manager/find_url", { name: m.name, folder: m.folder });

    if (!resp.candidates?.length) {
      notify("Hiç sonuç bulunamadı", "error");
      renderModels(pane);
      return;
    }

    // Tek tam eşleşme varsa direkt kullan
    const exact = resp.candidates.find(c => c.exact);
    if (exact && resp.candidates.length === 1) {
      m.url = exact.url;
      notify(`✓ Bulundu: ${exact.source}`, "success");
      renderModels(pane);
      return;
    }

    // Birden fazla aday → seçim modalı
    showCandidates(pane, m, resp.candidates, resp.query);
  } catch(e) {
    notify(`Arama hatası: ${e.message}`, "error");
    renderModels(pane);
  }
}

function showCandidates(pane, model, candidates, query) {
  pane.querySelector("#mr-candidates-modal")?.remove();

  const modal = document.createElement("div");
  modal.id = "mr-candidates-modal";
  modal.style.cssText = "position:absolute;inset:0;background:rgba(5,5,15,0.97);z-index:20;overflow-y:auto;padding:14px;";
  pane.style.position = "relative";

  const sourceIcon = s => s === "huggingface" ? "🤗" : "🎨";
  const scoreBar = s => {
    const pct = Math.round(Math.min(s * 100, 100));
    const col = pct > 70 ? "#2a9d5c" : pct > 40 ? "#c8a800" : "#8b3a3a";
    return `<div style="height:3px;background:#1a1a30;border-radius:2px;margin-top:4px">
      <div style="width:${pct}%;height:100%;background:${col};border-radius:2px"></div>
    </div><div style="font-size:9px;color:#333360;margin-top:2px">Eşleşme: ${pct}%</div>`;
  };

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div>
        <div style="font-size:13px;font-weight:600;color:#a0a8ff">Eşleşen modeller</div>
        <div style="font-size:10px;color:#444466;margin-top:2px">
          "<code style="color:#7878cc">${query}</code>" için ${candidates.length} aday
        </div>
      </div>
      <button class="sm-btn sm-btn-ghost" id="mr-cand-close" style="padding:3px 8px;font-size:10px">✕ Kapat</button>
    </div>
    ${candidates.map((c, i) => `
      <div class="sm-card" id="mr-cand-${i}" style="cursor:pointer;border-color:${c.exact ? "#1a4a2a" : "#1e1e38"}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:12px">${sourceIcon(c.source)} <strong>${c.source}</strong></span>
              ${c.exact ? `<span class="sm-badge sm-badge-done">✓ Tam eşleşme</span>` : ""}
              ${c.file_size_mb ? `<span class="sm-tag">${c.file_size_mb} MB</span>` : ""}
              ${c.downloads ? `<span class="sm-tag">⬇ ${c.downloads.toLocaleString()}</span>` : ""}
            </div>
            ${c.model_name ? `<div style="font-size:11px;color:#c0c0e0;margin-top:3px">${c.model_name}${c.version_name ? " · " + c.version_name : ""}</div>` : ""}
            <div style="font-size:10px;color:#555580;margin-top:2px;word-break:break-all">${c.file_name}</div>
            <div style="font-size:9px;color:#333360;margin-top:1px">${c.repo_id}</div>
            ${scoreBar(c.score)}
          </div>
          ${c.thumbnail ? `<img src="${c.thumbnail}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ""}
        </div>
      </div>
    `).join("")}
    <div style="margin-top:10px;font-size:10px;color:#333360;text-align:center">
      Hiçbiri doğru değilse →
      <a href="https://civitai.com/search/models?query=${encodeURIComponent(model.name)}"
        target="_blank" style="color:#5050cc">CivitAI'da ara ↗</a>
    </div>
  `;

  pane.appendChild(modal);
  modal.querySelector("#mr-cand-close").onclick = () => modal.remove();
  candidates.forEach((c, i) => {
    modal.querySelector(`#mr-cand-${i}`)?.addEventListener("click", () => {
      model.url = c.url;
      modal.remove();
      notify(`✓ Seçildi: ${c.file_name}`, "success");
      renderModels(pane);
    });
  });
}

async function startDownload(pane, m) {
  if (!m.url) return;
  try {
    await apiPost("/smart_manager/download", {
      name: m.name, folder: m.folder, url: m.url
    });
    m.status  = "downloading";
    m.percent = 0;
    renderModels(pane);
    startPolling(pane);
  } catch(e) {
    notify(`İndirme başlatılamadı: ${e.message}`, "error");
  }
}

async function downloadAll(pane) {
  const missing = _models.filter(m => !m.exists && m.status !== "done");

  // Önce URL bul — en yüksek skorlu adayı otomatik seç
  for (const m of missing) {
    if (!m.url) {
      const r = await apiPost("/smart_manager/find_url", { name: m.name, folder: m.folder });
      const best = r.candidates?.[0];
      if (best?.url) m.url = best.url;
    }
  }

  // Sonra indir
  let started = 0;
  for (const m of missing) {
    if (m.url) {
      await apiPost("/smart_manager/download", { name: m.name, folder: m.folder, url: m.url });
      m.status = "downloading"; m.percent = 0;
      started++;
    }
  }
  notify(`${started} model indirmeye başlandı`, "success");
  renderModels(pane);
  startPolling(pane);
}

function startPolling(pane) {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    try {
      const prog = await apiGet("/smart_manager/download_progress");
      let active = false;

      for (const m of _models) {
        const key = `${m.folder}/${m.name}`;
        if (prog[key]) {
          m.status  = prog[key].status;
          m.percent = prog[key].percent;
          if (m.status === "done")   m.exists = true;
          if (m.status === "downloading") active = true;
        }
      }
      renderModels(pane);

      const status = pane.querySelector("#mr-status");
      const remaining = _models.filter(m => m.status === "downloading");
      if (remaining.length && status) {
        const info = remaining.map(m => `${m.name.split(".")[0]} ${m.percent||0}%`).join(", ");
        status.textContent = `İndiriliyor: ${info}`;
      }

      if (!active) {
        clearInterval(_pollTimer);
        _pollTimer = null;
        const done = _models.filter(m => m.status === "done").length;
        if (done && status) status.textContent = `✓ ${done} model indirildi`;
      }
    } catch(e) {}
  }, 900);
}

async function showLocalModels(pane) {
  const list   = pane.querySelector("#mr-list");
  const status = pane.querySelector("#mr-status");
  list.innerHTML = `<div class="sm-empty sm-loading">Modeller listeleniyor</div>`;

  try {
    const data = await apiGet("/smart_manager/local_models");
    let html = "";
    let total = 0;

    for (const [folder, files] of Object.entries(data)) {
      if (!files.length) continue;
      html += `<div class="sm-section-title">${folder} (${files.length})</div>`;
      for (const f of files) {
        total++;
        html += `
          <div class="sm-card" style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;word-break:break-all;flex:1">${f.name}</span>
            <span style="font-size:10px;color:#444466;flex-shrink:0;margin-left:8px">${formatBytes(f.size_mb)}</span>
          </div>
        `;
      }
    }

    if (!html) html = `<div class="sm-empty">Hiç model bulunamadı.</div>`;
    list.innerHTML = html;
    status.textContent = `${total} model lokalde mevcut`;
  } catch(e) {
    list.innerHTML = `<div class="sm-empty">Hata: ${e.message}</div>`;
  }
}
