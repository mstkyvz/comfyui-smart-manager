"""
CivitAI Browser — Backend
Model arama, thumbnail, metadata ve indirme (API token destekli).
"""

import json, os, threading, urllib.request, urllib.parse, urllib.error
from pathlib import Path
import server
from aiohttp import web

# ── Config ────────────────────────────────────────────────────────────────

CIVITAI_API   = "https://civitai.com/api/v1"
CONFIG_FILE   = Path(__file__).parent.parent / "config.json"

_download_progress: dict[str, dict] = {}
_dl_lock = threading.Lock()


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception:
            pass
    return {}


def save_config(cfg: dict):
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


def get_civitai_token() -> str | None:
    return load_config().get("civitai_token")


def get_comfyui_root() -> Path:
    return Path(__file__).parent.parent.parent.parent


def get_models_dir() -> Path:
    return get_comfyui_root() / "models"


# ── CivitAI API yardımcıları ───────────────────────────────────────────────

FOLDER_MAP = {
    "Checkpoint":      "checkpoints",
    "LORA":            "loras",
    "LoCon":           "loras",
    "TextualInversion": "embeddings",
    "Controlnet":      "controlnet",
    "Upscaler":        "upscale_models",
    "VAE":             "vae",
    "AestheticGradient": "embeddings",
    "Poses":           "poses",
    "Wildcards":       "wildcards",
    "Other":           "other",
}


def _civitai_request(path: str, params: dict | None = None) -> dict | list | None:
    token = get_civitai_token()
    url = f"{CIVITAI_API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": "ComfyUI-SmartManager/1.0", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"[CivitAI] HTTP {e.code}: {path}")
        return None
    except Exception as e:
        print(f"[CivitAI] Hata: {e}")
        return None


def search_models(query: str, model_type: str = "", limit: int = 20, page: int = 1) -> dict:
    params = {"limit": limit, "page": page, "sort": "Most Downloaded"}
    if query:
        params["query"] = query
    if model_type and model_type != "All":
        params["types"] = model_type
    data = _civitai_request("/models", params)
    if not data:
        return {"items": [], "metadata": {}}

    items = []
    for model in data.get("items", []):
        # En güncel versiyon
        versions = model.get("modelVersions", [])
        latest = versions[0] if versions else {}
        files  = latest.get("files", [])
        images = latest.get("images", [])

        # Ana dosya
        main_file = next((f for f in files if f.get("primary")), files[0] if files else {})

        # Thumbnail
        thumb = None
        for img in images:
            if img.get("url"):
                thumb = img["url"]
                break

        model_type_raw = model.get("type", "Other")
        folder = FOLDER_MAP.get(model_type_raw, "other")

        items.append({
            "id":          model.get("id"),
            "name":        model.get("name", ""),
            "type":        model_type_raw,
            "folder":      folder,
            "description": (model.get("description") or "")[:200],
            "thumbnail":   thumb,
            "downloads":   model.get("stats", {}).get("downloadCount", 0),
            "rating":      round(model.get("stats", {}).get("rating", 0), 1),
            "tags":        model.get("tags", [])[:5],
            "version_id":  latest.get("id"),
            "version_name": latest.get("name", ""),
            "file_name":   main_file.get("name", ""),
            "file_size_mb": round((main_file.get("sizeKB", 0) or 0) / 1024, 1),
            "download_url": main_file.get("downloadUrl", ""),
            "base_model":  latest.get("baseModel", ""),
            "nsfw":        model.get("nsfw", False),
        })

    return {
        "items": items,
        "metadata": data.get("metadata", {}),
    }


def get_model_detail(model_id: int) -> dict | None:
    data = _civitai_request(f"/models/{model_id}")
    if not data:
        return None

    versions = []
    for v in data.get("modelVersions", []):
        files  = v.get("files", [])
        images = v.get("images", [])
        main   = next((f for f in files if f.get("primary")), files[0] if files else {})
        thumbs = [img["url"] for img in images if img.get("url")][:6]
        versions.append({
            "id":           v.get("id"),
            "name":         v.get("name", ""),
            "base_model":   v.get("baseModel", ""),
            "file_name":    main.get("name", ""),
            "file_size_mb": round((main.get("sizeKB", 0) or 0) / 1024, 1),
            "download_url": main.get("downloadUrl", ""),
            "images":       thumbs,
            "created_at":   v.get("createdAt", ""),
        })

    return {
        "id":          data.get("id"),
        "name":        data.get("name", ""),
        "type":        data.get("type", ""),
        "folder":      FOLDER_MAP.get(data.get("type", ""), "other"),
        "description": data.get("description") or "",
        "creator":     data.get("creator", {}).get("username", ""),
        "tags":        data.get("tags", []),
        "nsfw":        data.get("nsfw", False),
        "stats":       data.get("stats", {}),
        "versions":    versions,
    }


def _download_civitai(name: str, folder: str, url: str, token: str | None):
    key = f"{folder}/{name}"
    dest = get_models_dir() / folder / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp  = dest.with_suffix(dest.suffix + ".tmp")

    with _dl_lock:
        _download_progress[key] = {"status": "downloading", "percent": 0,
                                    "downloaded_mb": 0, "total_mb": 0, "error": None}
    try:
        headers = {"User-Agent": "ComfyUI-SmartManager/1.0"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            total = int(r.headers.get("Content-Length", 0))
            downloaded = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    with _dl_lock:
                        _download_progress[key]["downloaded_mb"] = round(downloaded / 1024 / 1024, 1)
                        _download_progress[key]["total_mb"] = round(total / 1024 / 1024, 1)
                        if total:
                            _download_progress[key]["percent"] = round(downloaded / total * 100, 1)

        tmp.rename(dest)
        with _dl_lock:
            _download_progress[key] = {"status": "done", "percent": 100,
                                        "downloaded_mb": round(dest.stat().st_size / 1024 / 1024, 1),
                                        "error": None}
        print(f"[CivitAI] ✓ İndirildi: {key}")
    except Exception as e:
        if tmp.exists():
            tmp.unlink()
        with _dl_lock:
            _download_progress[key] = {"status": "error", "percent": 0,
                                        "downloaded_mb": 0, "error": str(e)}
        print(f"[CivitAI] ✗ Hata ({key}): {e}")


# ── API Endpoint'leri ──────────────────────────────────────────────────────

@server.PromptServer.instance.routes.get("/smart_manager/civitai/search")
async def civitai_search(request):
    query      = request.rel_url.query.get("q", "")
    model_type = request.rel_url.query.get("type", "")
    limit      = int(request.rel_url.query.get("limit", 20))
    page       = int(request.rel_url.query.get("page", 1))
    try:
        result = search_models(query, model_type, limit, page)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/smart_manager/civitai/model/{model_id}")
async def civitai_model_detail(request):
    try:
        model_id = int(request.match_info["model_id"])
        detail = get_model_detail(model_id)
        if not detail:
            return web.json_response({"error": "Model bulunamadı"}, status=404)
        return web.json_response(detail)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/smart_manager/civitai/download")
async def civitai_download(request):
    try:
        data   = await request.json()
        name   = data.get("name", "")
        folder = data.get("folder", "")
        url    = data.get("url", "")
        if not all([name, folder, url]):
            return web.json_response({"error": "name, folder, url gerekli"}, status=400)
        token = get_civitai_token()
        key   = f"{folder}/{name}"
        if _download_progress.get(key, {}).get("status") == "downloading":
            return web.json_response({"status": "already_running"})
        threading.Thread(
            target=_download_civitai, args=(name, folder, url, token), daemon=True
        ).start()
        return web.json_response({"status": "started", "key": key,
                                   "has_token": bool(token)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/smart_manager/civitai/progress")
async def civitai_progress(request):
    with _dl_lock:
        return web.json_response(dict(_download_progress))


@server.PromptServer.instance.routes.get("/smart_manager/config")
async def get_config(request):
    cfg = load_config()
    # Token'ı maskele
    if cfg.get("civitai_token"):
        t = cfg["civitai_token"]
        cfg["civitai_token_masked"] = t[:4] + "****" + t[-4:] if len(t) > 8 else "****"
    cfg.pop("civitai_token", None)
    return web.json_response(cfg)


@server.PromptServer.instance.routes.post("/smart_manager/config")
async def set_config(request):
    try:
        data = await request.json()
        cfg  = load_config()
        if "civitai_token" in data:
            cfg["civitai_token"] = data["civitai_token"]
        if "hf_token" in data:
            cfg["hf_token"] = data["hf_token"]
        save_config(cfg)
        return web.json_response({"status": "saved"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
