/**
 * Prompt History Paneli
 * Üretim geçmişini gösterir: prompt, parametreler, çıktılar, süre.
 */

import { apiGet, apiDelete, apiPost, formatBytes, timeAgo, notify } from "./panel.js";
import { app } from "../../scripts/app.js";

const PAGE_SIZE = 20;
let _offset  = 0;
let _total   = 0;
let _search  = "";

export function mount(pane) {
  pane.innerHTML = `
    <div class="sm-search" style="gap:6px">
      <input type="text" id="hist-search" placeholder="Prompt veya model ara…" style="flex:1">
      <select id="hist-status" style="background:#0a0a1a;border:1px solid #2a2a40;border-radius:6px;color:#d0d0e8;padding:6px 8px;font-size:12px;outline:none">
        <option value="">Tümü</option>
        <option value="success">✓ Başarılı</option>
        <option value="error">✗ Hata</option>
      </select>
    </div>
    <div id="hist-stats" style="padding:6px 12px;border-bottom:1px solid #1a1a30;font-size:10px;color:#444466;flex-shrink:0"></div>
    <div class="sm-scroll" id="hist-list">
      <div class="sm-empty sm-loading">Yükleniyor</div>
    </div>
    <div class="sm-footer" style="justify-content:space-between;align-items:center">
      <button class="sm-btn sm-btn-ghost" id="hist-prev" disabled>‹</button>
      <span id="hist-page-info" style="font-size:11px;color:#444466"></span>
      <button class="sm-btn sm-btn-ghost" id="hist-next" disabled>›</button>
      <button class="sm-btn sm-btn-danger" id="hist-clear" style="margin-left:auto">🗑 Temizle</button>
    </div>
  `;

  let searchTimer = null;
  pane.querySelector("#hist-search").oninput = e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { _search = e.target.value; _offset = 0; loadHistory(pane); }, 400);
  };
  pane.querySelector("#hist-status").onchange = () => { _offset = 0; loadHistory(pane); };
  pane.querySelector("#hist-prev").onclick = () => { _offset = Math.max(0, _offset - PAGE_SIZE); loadHistory(pane); };
  pane.querySelector("#hist-next").onclick = () => { _offset += PAGE_SIZE; loadHistory(pane); };
  pane.querySelector("#hist-clear").onclick = () => clearHistory(pane);

  loadHistory(pane);
  loadStats(pane);
}

async function loadStats(pane) {
  try {
    const stats = await apiGet("/smart_manager/history/stats");
    const el    = pane.querySelector("#hist-stats");
    if (!el) return;
    const topCk = stats.top_checkpoints?.[0]?.[0]?.replace(".safetensors","").slice(0,20) || "—";
    el.textContent =
      `${stats.total} üretim · Ort. ${stats.avg_duration_s}s · En çok: ${topCk}`;
  } catch(e) {}
}

async function loadHistory(pane) {
  const list      = pane.querySelector("#hist-list");
  const status    = pane.querySelector("#hist-status").value;
  const pageInfo  = pane.querySelector("#hist-page-info");
  const prevBtn   = pane.querySelector("#hist-prev");
  const nextBtn   = pane.querySelector("#hist-next");

  list.innerHTML = `<div class="sm-empty sm-loading">Yükleniyor</div>`;

  try {
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset: _offset, search: _search, status });
    const data   = await apiGet(`/smart_manager/history?${params}`);
    const entries = data.entries || [];
    _total = data.total || 0;

    if (!entries.length) {
      list.innerHTML = `<div class="sm-empty">
        ${_offset === 0 ? "Henüz üretim geçmişi yok.<br>Bir workflow çalıştır, otomatik kaydedilir." : "Sonuç yok."}
      </div>`;
    } else {
      list.innerHTML = entries.map(e => entryCard(e)).join("");
      entries.forEach(e => {
        pane.querySelector(`#hist-del-${e.id}`)?.addEventListener("click", ev => {
          ev.stopPropagation();
          deleteEntry(pane, e.id);
        });
        pane.querySelector(`#hist-card-${e.id}`)?.addEventListener("click", () =>
          showDetail(pane, e)
        );
      });
    }

    const page = Math.floor(_offset / PAGE_SIZE) + 1;
    const pages = Math.ceil(_total / PAGE_SIZE) || 1;
    pageInfo.textContent = `${page} / ${pages}  (${_total})`;
    prevBtn.disabled = _offset === 0;
    nextBtn.disabled = _offset + PAGE_SIZE >= _total;
  } catch(e) {
    list.innerHTML = `<div class="sm-empty">Hata: ${e.message}</div>`;
  }
}

function entryCard(e) {
  const params    = e.params || {};
  const prompts   = params.prompts || [];
  const preview   = prompts[0]?.slice(0, 80) || "(prompt yok)";
  const ck        = (params.checkpoint || "").replace(".safetensors","").slice(0, 22);
  const stepInfo  = [params.steps && `${params.steps}s`, params.cfg && `cfg${params.cfg}`]
    .filter(Boolean).join(" · ");
  const size      = params.width && params.height ? `${params.width}×${params.height}` : "";
  const isOk      = e.status === "success";
  const thumb     = e.outputs?.[0];

  return `
    <div class="sm-card" id="hist-card-${e.id}" style="cursor:pointer;display:flex;gap:8px">
      ${thumb ? `<img src="/view?filename=${encodeURIComponent(thumb)}&type=output" 
        style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0" 
        loading="lazy" onerror="this.style.display='none'">` 
        : `<div style="width:56px;height:56px;background:#0d0d1e;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px">🖼</div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:#a0a8c8;line-height:1.4;word-break:break-word">${preview}${prompts[0]?.length > 80 ? "…" : ""}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;align-items:center">
          ${ck ? `<span class="sm-tag">${ck}</span>` : ""}
          ${stepInfo ? `<span class="sm-tag">${stepInfo}</span>` : ""}
          ${size ? `<span class="sm-tag">${size}</span>` : ""}
          <span class="sm-tag">${e.duration_s}s</span>
          <span class="sm-tag" style="color:${isOk ? "#4caf7a" : "#cf6060"}">${isOk ? "✓" : "✗"}</span>
        </div>
        <div style="font-size:10px;color:#333360;margin-top:3px">${timeAgo(e.created_at)}</div>
      </div>
      <button class="sm-btn sm-btn-danger" id="hist-del-${e.id}" 
        style="padding:2px 6px;font-size:10px;flex-shrink:0;align-self:flex-start">🗑</button>
    </div>
  `;
}

function showDetail(pane, entry) {
  const params  = entry.params || {};
  const prompts = params.prompts || [];

  const modal = document.createElement("div");
  modal.style.cssText = "position:absolute;inset:0;background:#0a0a16;z-index:10;overflow-y:auto;padding:12px;";

  const outputs   = entry.outputs || [];
  const thumbsHTML = outputs.map(f =>
    `<img src="/view?filename=${encodeURIComponent(f)}&type=output" 
      style="width:calc(50% - 4px);border-radius:6px;object-fit:cover" 
      loading="lazy" onerror="this.style.display='none'">`
  ).join("");

  const rows = [
    ["Checkpoint",  (params.checkpoint||"").replace(".safetensors","")],
    ["Steps",       params.steps],
    ["CFG",         params.cfg],
    ["Sampler",     params.sampler],
    ["Scheduler",   params.scheduler],
    ["Seed",        params.seed],
    ["Boyut",       params.width && `${params.width}×${params.height}`],
    ["Batch",       params.batch],
    ["Süre",        `${entry.duration_s}s`],
    ["Node Sayısı", entry.node_count],
    ["Durum",       entry.status],
  ].filter(([, v]) => v != null && v !== "");

  const lorasHTML = (params.loras || []).map(l =>
    `<div class="sm-card" style="font-size:11px;display:flex;justify-content:space-between">
      <span>${l.name}</span>
      <span style="color:#444466">${l.strength}</span>
    </div>`
  ).join("");

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-size:12px;font-weight:600;color:#a0a8ff">${timeAgo(entry.created_at)}</span>
      <button class="sm-btn sm-btn-ghost" id="hist-modal-close" style="padding:3px 8px;font-size:10px">✕ Kapat</button>
    </div>
    ${thumbsHTML ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${thumbsHTML}</div>` : ""}
    ${prompts.map((p, i) => `
      <div class="sm-section-title">Prompt ${i + 1}</div>
      <div class="sm-card" style="font-size:11px;line-height:1.6;color:#c0c0e0;word-break:break-word">${p}</div>
    `).join("")}
    <div class="sm-section-title">Parametreler</div>
    <div class="sm-card">
      ${rows.map(([k, v]) => `
        <div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1a1a30;font-size:11px">
          <span style="color:#444466">${k}</span>
          <span style="word-break:break-all;text-align:right;max-width:65%">${v}</span>
        </div>
      `).join("")}
    </div>
    ${lorasHTML ? `<div class="sm-section-title">LoRA'lar</div>${lorasHTML}` : ""}
  `;

  pane.style.position = "relative";
  pane.appendChild(modal);
  modal.querySelector("#hist-modal-close").onclick = () => modal.remove();
}

async function deleteEntry(pane, entryId) {
  try {
    await apiDelete(`/smart_manager/history/${entryId}`);
    notify("Kayıt silindi", "info");
    loadHistory(pane);
  } catch(e) {
    notify(`Hata: ${e.message}`, "error");
  }
}

async function clearHistory(pane) {
  if (!confirm(`Tüm geçmiş silinsin mi? (${_total} kayıt)`)) return;
  try {
    await fetch("/smart_manager/history", { method: "DELETE" });
    _offset = 0;
    notify("Geçmiş temizlendi", "info");
    loadHistory(pane);
    loadStats(pane);
  } catch(e) {
    notify(`Hata: ${e.message}`, "error");
  }
}
