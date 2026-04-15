"""
Prompt History — Backend
Her üretimi otomatik kaydeder: prompt, parametreler, çıktı görüntüleri, süre.
ComfyUI'nin execution hook'una bağlanır, ekstra node gerekmez.
"""

import json, time, uuid, os
from pathlib import Path
from datetime import datetime
import server
from aiohttp import web

HISTORY_DIR  = Path(__file__).parent.parent.parent.parent / "smart_manager_data" / "history"
MAX_ENTRIES  = 500  # Toplam max kayıt

# ComfyUI'den output path'i al
def get_output_dir() -> Path:
    try:
        import folder_paths
        return Path(folder_paths.get_output_directory())
    except Exception:
        return Path(__file__).parent.parent.parent.parent / "output"


def ensure_dir():
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)


def _extract_params(workflow: dict) -> dict:
    """Workflow'dan kullanıcıya gösterilecek parametreleri çıkar."""
    params = {}
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct     = node.get("class_type", "")
        inputs = node.get("inputs", {})

        if ct in ("KSampler", "KSamplerAdvanced"):
            params.update({
                "steps":    inputs.get("steps"),
                "cfg":      inputs.get("cfg"),
                "sampler":  inputs.get("sampler_name"),
                "scheduler":inputs.get("scheduler"),
                "seed":     inputs.get("seed"),
                "denoise":  inputs.get("denoise"),
            })
        elif ct == "CLIPTextEncode":
            text = inputs.get("text", "")
            if text and isinstance(text, str):
                # Pozitif/negatif ayrımını node bağlantısından anlamak zor,
                # ikisini de kaydet
                params.setdefault("prompts", [])
                if len(text) > 5:
                    params["prompts"].append(text[:500])
        elif ct in ("CheckpointLoaderSimple", "CheckpointLoader"):
            params["checkpoint"] = inputs.get("ckpt_name", "")
        elif ct == "LoraLoader":
            params.setdefault("loras", [])
            params["loras"].append({
                "name":     inputs.get("lora_name", ""),
                "strength": inputs.get("strength_model"),
            })
        elif ct in ("EmptyLatentImage", "EmptySD3LatentImage"):
            params["width"]  = inputs.get("width")
            params["height"] = inputs.get("height")
            params["batch"]  = inputs.get("batch_size", 1)

    # Boşları temizle
    return {k: v for k, v in params.items() if v is not None and v != "" and v != []}


def save_entry(prompt_id: str, workflow: dict, outputs: list[str],
               duration_s: float, status: str = "success"):
    ensure_dir()
    params  = _extract_params(workflow)
    entry_id = str(uuid.uuid4())[:8]

    entry = {
        "id":          entry_id,
        "prompt_id":   prompt_id,
        "created_at":  datetime.now().isoformat(),
        "status":      status,
        "duration_s":  round(duration_s, 2),
        "params":      params,
        "outputs":     outputs,
        "node_count":  len(workflow),
    }

    path = HISTORY_DIR / f"{entry_id}.json"
    path.write_text(json.dumps(entry, indent=2))

    # Eski kayıtları sil
    _prune()
    return entry_id


def _prune():
    files = sorted(HISTORY_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime)
    if len(files) > MAX_ENTRIES:
        for f in files[:len(files) - MAX_ENTRIES]:
            f.unlink(missing_ok=True)


def list_entries(limit: int = 50, offset: int = 0,
                 search: str = "", status: str = "") -> dict:
    ensure_dir()
    entries = []
    for f in sorted(HISTORY_DIR.glob("*.json"),
                    key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            e = json.loads(f.read_text())
            # Filtre
            if status and e.get("status") != status:
                continue
            if search:
                haystack = json.dumps(e.get("params", {})).lower()
                if search.lower() not in haystack:
                    continue
            entries.append({
                "id":         e["id"],
                "created_at": e["created_at"],
                "status":     e.get("status", "success"),
                "duration_s": e.get("duration_s", 0),
                "params":     e.get("params", {}),
                "outputs":    e.get("outputs", []),
                "node_count": e.get("node_count", 0),
            })
        except Exception:
            pass

    total = len(entries)
    return {
        "entries":  entries[offset:offset + limit],
        "total":    total,
        "limit":    limit,
        "offset":   offset,
    }


def get_entry(entry_id: str) -> dict | None:
    for f in HISTORY_DIR.glob("*.json"):
        try:
            e = json.loads(f.read_text())
            if e.get("id") == entry_id or e.get("prompt_id") == entry_id:
                return e
        except Exception:
            pass
    return None


def delete_entry(entry_id: str) -> bool:
    for f in HISTORY_DIR.glob("*.json"):
        try:
            e = json.loads(f.read_text())
            if e.get("id") == entry_id:
                f.unlink()
                return True
        except Exception:
            pass
    return False


def clear_history():
    for f in HISTORY_DIR.glob("*.json"):
        f.unlink(missing_ok=True)


# ── ComfyUI execution hook ─────────────────────────────────────────────────
# ComfyUI tamamlanan her prompt için server.PromptServer.instance.send_sync çağırır.
# Biz bunu dinleyerek otomatik kayıt yaparız.

_pending: dict[str, dict] = {}   # prompt_id → {workflow, start_time}


def _on_prompt_queued(prompt_id: str, workflow: dict):
    _pending[prompt_id] = {"workflow": workflow, "start": time.time()}


def _on_prompt_done(prompt_id: str, outputs: list[str], status: str = "success"):
    info = _pending.pop(prompt_id, None)
    if info:
        duration = time.time() - info["start"]
        save_entry(prompt_id, info["workflow"], outputs, duration, status)


# ComfyUI PromptServer'ının on_prompt_handlers listesine ekle
try:
    original_queue = server.PromptServer.instance.prompt_queue.put.__func__

    class _QueueHook:
        """PromptQueue.put'u sararak workflow'u yakalar."""
        def __init__(self, original_put, queue_instance):
            self._orig = original_put
            self._q    = queue_instance

        def __call__(self, item):
            try:
                # item: (number, prompt_id, prompt, extra_data, outputs_to_execute)
                if len(item) >= 3:
                    prompt_id = item[1]
                    workflow  = item[2]  # Bu API prompt formatında
                    _on_prompt_queued(prompt_id, workflow)
            except Exception:
                pass
            return self._orig(self._q, item)

    # Monkey-patch yap
    import types
    q = server.PromptServer.instance.prompt_queue
    q.put = types.MethodType(
        lambda self, item: _QueueHook(original_queue, self)(item), q
    )
except Exception as e:
    print(f"[History] Queue hook kurulamadı (opsiyonel): {e}")


# ── API Endpoint'leri ──────────────────────────────────────────────────────

@server.PromptServer.instance.routes.get("/smart_manager/history")
async def history_list(request):
    q      = request.rel_url.query
    limit  = int(q.get("limit", 50))
    offset = int(q.get("offset", 0))
    search = q.get("search", "")
    status = q.get("status", "")
    return web.json_response(list_entries(limit, offset, search, status))


@server.PromptServer.instance.routes.get("/smart_manager/history/{entry_id}")
async def history_get(request):
    entry = get_entry(request.match_info["entry_id"])
    if not entry:
        return web.json_response({"error": "Bulunamadı"}, status=404)
    return web.json_response(entry)


@server.PromptServer.instance.routes.delete("/smart_manager/history/{entry_id}")
async def history_delete(request):
    ok = delete_entry(request.match_info["entry_id"])
    return web.json_response({"deleted": ok})


@server.PromptServer.instance.routes.delete("/smart_manager/history")
async def history_clear(request):
    clear_history()
    return web.json_response({"cleared": True})


@server.PromptServer.instance.routes.post("/smart_manager/history/manual")
async def history_manual(request):
    """Frontend'den manuel kayıt (hook çalışmazsa fallback)."""
    try:
        data      = await request.json()
        prompt_id = data.get("prompt_id", str(uuid.uuid4())[:8])
        workflow  = data.get("workflow", {})
        outputs   = data.get("outputs", [])
        duration  = data.get("duration_s", 0)
        status    = data.get("status", "success")
        entry_id  = save_entry(prompt_id, workflow, outputs, duration, status)
        return web.json_response({"id": entry_id})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/smart_manager/history/stats")
async def history_stats(request):
    data = list_entries(limit=MAX_ENTRIES)
    entries = data["entries"]
    total   = data["total"]
    if entries:
        avg_dur = sum(e.get("duration_s", 0) for e in entries) / len(entries)
        checkpoints = {}
        for e in entries:
            ck = e.get("params", {}).get("checkpoint")
            if ck:
                checkpoints[ck] = checkpoints.get(ck, 0) + 1
        top_ck = sorted(checkpoints.items(), key=lambda x: -x[1])[:5]
    else:
        avg_dur = 0
        top_ck  = []
    return web.json_response({
        "total":              total,
        "avg_duration_s":     round(avg_dur, 1),
        "top_checkpoints":    top_ck,
    })
