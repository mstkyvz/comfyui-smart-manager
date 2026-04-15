/**
 * CivitAI Browser Paneli
 * Model arama, thumbnail gösterimi, indirme.
 */

import { apiGet, apiPost, formatBytes, notify } from "./panel.js";

const MODEL_TYPES = ["All","Checkpoint","LORA","TextualInversion",
                     "Controlnet","Upscaler","VAE"];

let _searchTimer = null;
let _pollTimer   = null;
let _currentPage = 1;
let _totalPages  = 1;
let _tokenSet    = false;

export function mount(pane) {
  pane.innerHTML = `
    <div class="sm-search" style="flex-wrap:wrap;gap:6px">
      <input type="text" id="cv-search" placeholder="Model ara… (Juggernaut, DreamShaper…)" style="flex:2;min-width:140px">
      <select id="cv-type" style="flex:1;min-width:80px">
        ${MODEL_TYPES.map(t => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <button class="sm-btn sm-btn-ghost" id="cv-token-btn" style="font-size:10px">🔑 Token</button>
    </div>
    <div id="cv-token-form" style="display:none;padding:8px 12px;border-bottom:1px solid #1a1a30;">
      <div style="font-size:11px;color:#6060a0;margin-bottom:6px">
        CivitAI API Token (civitai.com → Hesap → API Keys)
      </div>
      <div style="display:flex;gap:6px">
        <input type="password" id="cv-token-input" placeholder="Token…"
          style="flex:1;background:#0a0a1a;border:1px solid #2a2a40;border-radius:6px;
                 color:#d0d0e8;padding:5px 8px;font-size:12px;outline:none">
        <button class="sm-btn sm-btn-success" id="cv-token-save">Kaydet</button>
      </div>
      <div id="cv-token-status" style="font-size:10px;color:#444466;margin-top:4px"></div>
    </div>
    <div class="sm-scroll" id="cv-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 12px;">
      <div style="grid-column:1/-1" class="sm-empty">Aramak için yazmaya başla.</div>
    </div>
    <div class="sm-footer" style="justify-content:space-between;align-items:center">
      <button class="sm-btn sm-btn-ghost" id="cv-prev" disabled>‹ Önceki</button>
      <span id="cv-page-info" style="font-size:11px;color:#444466">—</span>
      <button class="sm-btn sm-btn-ghost" id="cv-next" disabled>Sonraki ›</button>
    </div>
    <!-- Model detay modalı -->
    <div id="cv-modal" style="display:none;position:absolute;inset:0;background:#0a0a16;
         z-index:10;overflow-y:auto;padding:12px;"></div>
  `;

  pane.style.position = "relative";

  const searchInput = pane.querySelector("#cv-search");
  const typeSelect  = pane.querySelector("#cv-type");

  searchInput.oninput = () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { _currentPage = 1; doSearch(pane); }, 500);
  };
  typeSelect.onchange = () => { _currentPage = 1; doSearch(pane); };

  pane.querySelector("#cv-prev").onclick = () => { _currentPage--; doSearch(pane); };
  pane.querySelector("#cv-next").onclick = () => { _currentPage++; doSearch(pane); };

  pane.querySelector("#cv-token-btn").onclick = () => {
    const form = pane.querySelector("#cv-token-form");
    form.style.display = form.style.display === "none" ? "block" : "none";
  };

  pane.querySelector("#cv-token-save").onclick = async () => {
    const token  = pane.querySelector("#cv-token-input").value.trim();
    const status = pane.querySelector("#cv-token-status");
    if (!token) return;
    try {
      await apiPost("/smart_manager/config", { civitai_token: token });
      status.textContent = "✓ Token kaydedildi";
      status.style.color = "#4caf7a";
      _tokenSet = true;
      setTimeout(() => { pane.querySelector("#cv-token-form").style.display = "none"; }, 1000);
    } catch(e) {
      status.textContent = `Hata: ${e.message}`;
      status.style.color = "#cf6060";
    }
  };

  // Konfigü kontrol et
  apiGet("/smart_manager/config").then(cfg => {
    if (cfg.civitai_token_masked) {
      _tokenSet = true;
      pane.querySelector("#cv-token-status") &&
        (pane.querySelector("#cv-token-status").textContent = `Token aktif: ${cfg.civitai_token_masked}`);
    }
  }).catch(() => {});

  // İlk yükleme
  doSearch(pane);
}

async function doSearch(pane) {
  const grid   = pane.querySelector("#cv-grid");
  const query  = pane.querySelector("#cv-search").value.trim();
  const type   = pane.querySelector("#cv-type").value;
  const prev   = pane.querySelector("#cv-prev");
  const next   = pane.querySelector("#cv-next");
  const info   = pane.querySelector("#cv-page-info");

  grid.innerHTML = `<div style="grid-column:1/-1" class="sm-empty sm-loading">Aranıyor</div>`;
  prev.disabled = next.disabled = true;

  try {
    const params = new URLSearchParams({ q: query, type, page: _currentPage, limit: 20 });
    const data   = await apiGet(`/smart_manager/civitai/search?${params}`);
    const items  = data.items || [];
    const meta   = data.metadata || {};

    _totalPages = meta.totalPages || 1;

    if (!items.length) {
      grid.innerHTML = `<div style="grid-column:1/-1" class="sm-empty">Sonuç bulunamadı.</div>`;
    } else {
      grid.innerHTML = items.map(item => modelCard(item)).join("");
      // Tıklama event'leri
      items.forEach(item => {
        grid.querySelector(`#cv-card-${item.id}`)?.addEventListener("click", (e) => {
          if (!e.target.closest(".cv-dl-btn")) {
            showDetail(pane, item.id);
          }
        });
        grid.querySelector(`#cv-dl-quick-${item.id}`)?.addEventListener("click", (e) => {
          e.stopPropagation();
          quickDownload(pane, item);
        });
      });
    }

    info.textContent  = meta.totalItems ? `Sayfa ${_currentPage} / ${_totalPages}  (${meta.totalItems} sonuç)` : `Sayfa ${_currentPage}`;
    prev.disabled     = _currentPage <= 1;
    next.disabled     = _currentPage >= _totalPages;

  } catch(e) {
    grid.innerHTML = `<div style="grid-column:1/-1" class="sm-empty">Hata: ${e.message}</div>`;
  }
}

function modelCard(item) {
  const thumb = item.thumbnail
    ? `<img src="${item.thumbnail}" style="width:100%;height:120px;object-fit:cover;border-radius:6px 6px 0 0;display:block" loading="lazy" onerror="this.style.display='none'">`
    : `<div style="height:80px;background:#0d0d1e;border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:center;font-size:24px">🖼</div>`;

  const typeColor = {
    "Checkpoint": "#5050cc", "LORA": "#1a6640",
    "TextualInversion": "#663300", "Controlnet": "#006633",
    "VAE": "#440066", "Upscaler": "#444400",
  }[item.type] || "#333";

  return `
    <div class="sm-card" id="cv-card-${item.id}" style="cursor:pointer;padding:0;overflow:hidden">
      ${thumb}
      <div style="padding:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px">
          <span style="font-size:11px;font-weight:600;line-height:1.3;word-break:break-word;flex:1"
            title="${item.name}">${item.name.length > 30 ? item.name.slice(0,28)+"…" : item.name}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;margin-top:4px">
          <span style="font-size:9px;padding:1px 5px;border-radius:8px;background:${typeColor};color:#fff">${item.type}</span>
          ${item.base_model ? `<span class="sm-tag">${item.base_model}</span>` : ""}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
          <span style="font-size:10px;color:#444466">
            ⬇ ${(item.downloads||0).toLocaleString()}
            ${item.rating ? ` · ★ ${item.rating}` : ""}
          </span>
          <button class="sm-btn sm-btn-success cv-dl-btn" id="cv-dl-quick-${item.id}"
            style="padding:2px 8px;font-size:10px"
            title="${item.file_name} (${formatBytes(item.file_size_mb)})">
            ⬇ ${formatBytes(item.file_size_mb) || "İndir"}
          </button>
        </div>
      </div>
    </div>
  `;
}

async function showDetail(pane, modelId) {
  const modal = pane.querySelector("#cv-modal");
  modal.style.display = "block";
  modal.innerHTML = `<div class="sm-empty sm-loading">Yükleniyor</div>`;

  try {
    const detail = await apiGet(`/smart_manager/civitai/model/${modelId}`);

    const images = detail.versions?.[0]?.images?.slice(0, 4) || [];
    const imgHTML = images.map(url =>
      `<img src="${url}" style="width:calc(50% - 4px);height:120px;object-fit:cover;border-radius:6px" loading="lazy">`
    ).join("");

    const versionsHTML = (detail.versions || []).map((v, i) => `
      <div class="sm-card" style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:12px;font-weight:500">${v.name}</span>
          <span class="sm-tag" style="margin-left:4px">${v.base_model}</span>
          <div style="font-size:10px;color:#444466;margin-top:2px">${formatBytes(v.file_size_mb)}</div>
        </div>
        <button class="sm-btn sm-btn-success" onclick="window._smDownloadVersion(${JSON.stringify(v).replace(/"/g,'&quot;')}, '${detail.folder}')"
          style="padding:4px 10px;font-size:11px">⬇</button>
      </div>
    `).join("");

    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0;font-size:14px;color:#a0a8ff">${detail.name}</h3>
        <button class="sm-btn sm-btn-ghost" onclick="document.getElementById('cv-modal').style.display='none'">✕ Kapat</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        <span class="sm-tag">${detail.type}</span>
        ${(detail.tags||[]).slice(0,6).map(t=>`<span class="sm-tag">${t}</span>`).join("")}
        ${detail.nsfw ? `<span class="sm-tag" style="color:#cf6060">NSFW</span>` : ""}
      </div>
      ${imgHTML ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${imgHTML}</div>` : ""}
      <div class="sm-section-title">Versiyonlar</div>
      ${versionsHTML || `<div class="sm-empty">Versiyon bulunamadı.</div>`}
    `;

    // Global helper for onclick in innerHTML
    window._smDownloadVersion = async (version, folder) => {
      await downloadVersion(version, folder);
    };

  } catch(e) {
    modal.innerHTML = `
      <div class="sm-empty">Hata: ${e.message}</div>
      <div style="text-align:center;margin-top:8px">
        <button class="sm-btn sm-btn-ghost" onclick="document.getElementById('cv-modal').style.display='none'">Kapat</button>
      </div>
    `;
  }
}

async function quickDownload(pane, item) {
  if (!item.download_url || !item.file_name) {
    notify("İndirme URL'si bulunamadı", "error");
    return;
  }
  await downloadVersion({ ...item, file_name: item.file_name, download_url: item.download_url }, item.folder);
}

async function downloadVersion(version, folder) {
  const name = version.file_name;
  const url  = version.download_url;
  if (!name || !url) { notify("Dosya bilgisi eksik", "error"); return; }

  try {
    const resp = await apiPost("/smart_manager/civitai/download", { name, folder, url });
    notify(`İndirme başladı: ${name}`, "success");
    startProgressPoll();
  } catch(e) {
    notify(`Hata: ${e.message}`, "error");
  }
}

function startProgressPoll() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    try {
      const prog = await apiGet("/smart_manager/civitai/progress");
      let active = false;
      for (const [key, info] of Object.entries(prog)) {
        if (info.status === "downloading") { active = true; break; }
        if (info.status === "done") notify(`✓ İndirildi: ${key.split("/")[1]}`, "success");
      }
      if (!active) { clearInterval(_pollTimer); _pollTimer = null; }
    } catch(e) {}
  }, 1000);
}
