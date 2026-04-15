/**
 * ComfyUI Smart Manager — Ana Panel
 * Üst menüye buton ekler, 4 sekme ile tam panel açar:
 *   Model Resolver | CivitAI Browser | Snapshots | History
 */

import { app }    from "../../scripts/app.js";
import { api }    from "../../scripts/api.js";

// ── Ortak yardımcılar ──────────────────────────────────────────────────────

export async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function apiDelete(path) {
  const r = await fetch(path, { method: "DELETE" });
  return r.json();
}

export function getCurrentWorkflow() {
  try {
    const serialized = app.graph.serialize();
    // ComfyUI'nin kendi API format'ına çevir
    const result = {};
    for (const node of (serialized.nodes || [])) {
      const inputs = {};
      for (const [k, v] of Object.entries(node.widgets_values || {})) {
        inputs[k] = v;
      }
      // inputs property varsa onu kullan
      for (const inp of (node.inputs || [])) {
        if (inp.widget) inputs[inp.name] = inp.widget.value;
      }
      result[String(node.id)] = {
        class_type: node.type,
        inputs,
      };
    }
    return result;
  } catch (e) {
    console.error("[SmartManager] Workflow alınamadı:", e);
    return {};
  }
}

export function formatBytes(mb) {
  if (!mb) return "";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s önce`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}sa önce`;
  return `${Math.floor(diff / 86400)}g önce`;
}

// ── Stil enjeksiyonu ───────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById("sm-styles")) return;
  const s = document.createElement("style");
  s.id = "sm-styles";
  s.textContent = `
    #sm-panel {
      position: fixed; top: 0; right: 0;
      width: 480px; height: 100vh;
      background: #0f0f1a;
      border-left: 1px solid #2a2a40;
      display: flex; flex-direction: column;
      z-index: 9999;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 13px; color: #d0d0e8;
      box-shadow: -4px 0 24px rgba(0,0,0,0.6);
      transition: transform 0.25s ease;
    }
    #sm-panel.hidden { transform: translateX(100%); }
    #sm-header {
      background: #0a0a16;
      border-bottom: 1px solid #2a2a40;
      padding: 0 12px;
      display: flex; align-items: center; gap: 0;
      flex-shrink: 0; height: 48px;
    }
    #sm-header h2 {
      margin: 0; font-size: 13px; font-weight: 600;
      color: #7878ff; letter-spacing: 0.5px;
      white-space: nowrap; margin-right: 12px;
    }
    .sm-tabs {
      display: flex; flex: 1; gap: 2px; overflow-x: auto;
    }
    .sm-tab {
      padding: 6px 10px; border-radius: 6px; cursor: pointer;
      font-size: 11px; font-weight: 500; color: #6060a0;
      white-space: nowrap; transition: all 0.15s; border: none;
      background: transparent;
    }
    .sm-tab:hover  { color: #a0a8ff; background: #1a1a30; }
    .sm-tab.active { color: #a0a8ff; background: #1a1a30; }
    #sm-close {
      cursor: pointer; background: none; border: none;
      color: #444466; font-size: 20px; padding: 0 4px;
      flex-shrink: 0; line-height: 1;
    }
    #sm-close:hover { color: #fff; }
    #sm-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
    .sm-pane { display: none; flex: 1; overflow: hidden; flex-direction: column; }
    .sm-pane.active { display: flex; }

    /* Ortak bileşenler */
    .sm-search {
      display: flex; gap: 6px; padding: 10px 12px;
      border-bottom: 1px solid #1a1a30; flex-shrink: 0;
    }
    .sm-search input, .sm-search select {
      flex: 1; background: #0a0a1a; border: 1px solid #2a2a40;
      border-radius: 6px; color: #d0d0e8; padding: 6px 10px;
      font-size: 12px; outline: none;
    }
    .sm-search input:focus, .sm-search select:focus {
      border-color: #5050a0;
    }
    .sm-scroll { flex: 1; overflow-y: auto; padding: 8px 12px; }
    .sm-scroll::-webkit-scrollbar { width: 4px; }
    .sm-scroll::-webkit-scrollbar-thumb { background: #2a2a40; border-radius: 2px; }
    .sm-footer {
      padding: 8px 12px; border-top: 1px solid #1a1a30;
      display: flex; gap: 6px; flex-shrink: 0;
    }
    .sm-btn {
      padding: 6px 12px; border-radius: 6px; border: none;
      cursor: pointer; font-size: 11px; font-weight: 500;
      transition: opacity 0.15s; white-space: nowrap;
    }
    .sm-btn:hover { opacity: 0.85; }
    .sm-btn:disabled { opacity: 0.35; cursor: default; }
    .sm-btn-primary   { background: #5050cc; color: #fff; }
    .sm-btn-success   { background: #1a6640; color: #fff; }
    .sm-btn-danger    { background: #662020; color: #fff; }
    .sm-btn-ghost     { background: #1a1a30; color: #8080c0; border: 1px solid #2a2a40; }
    .sm-btn-civitai   { background: #1e3a5f; color: #7ab3f0; border: 1px solid #2a4a70; }
    .sm-card {
      background: #0d0d1e; border: 1px solid #1e1e38;
      border-radius: 8px; padding: 10px; margin-bottom: 6px;
    }
    .sm-card:hover { border-color: #3a3a60; }
    .sm-badge {
      display: inline-block; padding: 1px 6px; border-radius: 10px;
      font-size: 10px; font-weight: 600;
    }
    .sm-badge-ok      { background: #0d3320; color: #4caf7a; }
    .sm-badge-missing { background: #330d0d; color: #cf6060; }
    .sm-badge-dl      { background: #1a1a00; color: #c8b850; }
    .sm-badge-done    { background: #0d3320; color: #4caf7a; }
    .sm-badge-error   { background: #330d0d; color: #cf6060; }
    .sm-progress-bar {
      width: 100%; height: 3px; background: #1a1a30;
      border-radius: 2px; overflow: hidden; margin-top: 5px;
    }
    .sm-progress-fill {
      height: 100%; background: #5050cc;
      border-radius: 2px; transition: width 0.3s;
    }
    .sm-empty {
      text-align: center; color: #333360;
      padding: 40px 0; font-size: 12px;
    }
    .sm-section-title {
      font-size: 10px; font-weight: 700; color: #444466;
      text-transform: uppercase; letter-spacing: 1px;
      margin: 12px 0 6px;
    }
    .sm-tag {
      display: inline-block; padding: 1px 6px;
      background: #1a1a30; border-radius: 10px;
      font-size: 10px; color: #6060a0; margin: 1px;
    }
    @keyframes sm-spin { to { transform: rotate(360deg); } }
    .sm-loading::after {
      content: ''; display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid #3a3a60; border-top-color: #8080ff;
      border-radius: 50%; animation: sm-spin 0.7s linear infinite;
      vertical-align: middle; margin-left: 6px;
    }
    .sm-notification {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #1a1a30; border: 1px solid #3a3a60;
      color: #d0d0e8; padding: 8px 16px; border-radius: 8px;
      font-size: 12px; z-index: 99999;
      animation: sm-fadein 0.2s ease; pointer-events: none;
    }
    @keyframes sm-fadein { from { opacity: 0; transform: translateX(-50%) translateY(8px); } }
  `;
  document.head.appendChild(s);
}

export function notify(msg, type = "info") {
  const el = document.createElement("div");
  el.className = "sm-notification";
  if (type === "success") el.style.borderColor = "#1a6640";
  if (type === "error")   el.style.borderColor = "#662020";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Panel ──────────────────────────────────────────────────────────────────

const TABS = [
  { id: "resolver",  label: "🔍 Modeller" },
  { id: "civitai",   label: "🎨 CivitAI"  },
  { id: "snapshots", label: "📸 Snapshot" },
  { id: "history",   label: "📜 Geçmiş"  },
];

class SmartManagerPanel {
  constructor() {
    this.panel    = null;
    this.activeTab = "resolver";
    this.modules  = {};
  }

  async loadModules() {
    const [resolverMod, civitaiMod, snapshotMod, historyMod] = await Promise.all([
      import("./model_browser.js"),
      import("./civitai_browser.js"),
      import("./snapshot_panel.js"),
      import("./history_panel.js"),
    ]);
    this.modules = {
      resolver:  resolverMod,
      civitai:   civitaiMod,
      snapshots: snapshotMod,
      history:   historyMod,
    };
  }

  build() {
    injectStyles();

    const panel = document.createElement("div");
    panel.id = "sm-panel";
    panel.classList.add("hidden");
    panel.innerHTML = `
      <div id="sm-header">
        <h2>⚡ Smart Manager</h2>
        <div class="sm-tabs">
          ${TABS.map(t => `<button class="sm-tab${t.id === this.activeTab ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
        </div>
        <button id="sm-close">✕</button>
      </div>
      <div id="sm-content">
        ${TABS.map(t => `<div class="sm-pane${t.id === this.activeTab ? " active" : ""}" id="sm-pane-${t.id}"></div>`).join("")}
      </div>
    `;

    document.body.appendChild(panel);
    this.panel = panel;

    // Tab tıklamaları
    panel.querySelectorAll(".sm-tab").forEach(btn => {
      btn.onclick = () => this.switchTab(btn.dataset.tab);
    });

    panel.querySelector("#sm-close").onclick = () => this.close();

    // İlk tab'ı yükle
    this.renderTab(this.activeTab);
  }

  switchTab(tabId) {
    this.activeTab = tabId;
    this.panel.querySelectorAll(".sm-tab").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tabId)
    );
    this.panel.querySelectorAll(".sm-pane").forEach(p =>
      p.classList.toggle("active", p.id === `sm-pane-${tabId}`)
    );
    this.renderTab(tabId);
  }

  renderTab(tabId) {
    const pane = this.panel.querySelector(`#sm-pane-${tabId}`);
    if (!pane || pane._rendered) return;
    const mod = this.modules[tabId];
    if (mod?.mount) {
      mod.mount(pane);
      pane._rendered = true;
    }
  }

  async open() {
    if (!this.panel) {
      await this.loadModules();
      this.build();
    }
    this.panel.classList.remove("hidden");
    // Aktif tab'ı yenile
    const pane = this.panel.querySelector(`#sm-pane-${this.activeTab}`);
    if (pane) pane._rendered = false;
    this.renderTab(this.activeTab);
  }

  close() {
    this.panel?.classList.add("hidden");
  }

  toggle() {
    if (!this.panel || this.panel.classList.contains("hidden")) {
      this.open();
    } else {
      this.close();
    }
  }
}

const panel = new SmartManagerPanel();

// ── ComfyUI Extension kaydı ────────────────────────────────────────────────

app.registerExtension({
  name: "ComfyUI.SmartManager",

  async setup() {
    // Üst menü butonu
    const menu = document.querySelector(".comfy-menu");
    if (menu) {
      const btn = document.createElement("button");
      btn.innerHTML = "⚡ Smart Manager";
      btn.title = "Model Resolver | CivitAI | Snapshots | History";
      Object.assign(btn.style, {
        background: "#5050cc", color: "white",
        border: "none", borderRadius: "6px",
        padding: "5px 10px", fontSize: "12px",
        cursor: "pointer", margin: "2px", fontWeight: "500",
      });
      btn.onclick = () => panel.toggle();
      menu.appendChild(btn);
    }

    // Sağ tık menüsü
    const origExtra = app.canvas.getExtraMenuOptions?.bind(app.canvas);
    app.canvas.getExtraMenuOptions = function (_, options) {
      origExtra?.(_, options);
      options.push(null); // ayraç
      options.push({ content: "⚡ Smart Manager", callback: () => panel.open() });
    };

    // Klavye kısayolu: Ctrl+Shift+M
    document.addEventListener("keydown", e => {
      if (e.ctrlKey && e.shiftKey && e.key === "M") {
        e.preventDefault();
        panel.toggle();
      }
    });
  },
});
