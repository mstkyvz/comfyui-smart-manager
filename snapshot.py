"""
Snapshot System — Backend
Workflow versiyonlama: kaydet, geri al, karşılaştır.
Snapshot'lar  ComfyUI/smart_manager_data/snapshots/  altında JSON olarak saklanır.
"""

import json, time, hashlib
from pathlib import Path
from datetime import datetime
import server
from aiohttp import web

SNAPSHOTS_DIR = Path(__file__).parent.parent.parent.parent / "smart_manager_data" / "snapshots"
MAX_SNAPSHOTS = 50  # Proje başına max snapshot sayısı


def ensure_dir():
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def snapshot_path(snapshot_id: str) -> Path:
    return SNAPSHOTS_DIR / f"{snapshot_id}.json"


def list_snapshots(project: str | None = None) -> list[dict]:
    ensure_dir()
    snaps = []
    for f in sorted(SNAPSHOTS_DIR.iterdir(), reverse=True):
        if not f.suffix == ".json":
            continue
        try:
            meta = json.loads(f.read_text())
            if project and meta.get("project") != project:
                continue
            snaps.append({
                "id":          meta["id"],
                "name":        meta["name"],
                "project":     meta.get("project", "default"),
                "created_at":  meta["created_at"],
                "node_count":  meta.get("node_count", 0),
                "description": meta.get("description", ""),
                "tags":        meta.get("tags", []),
                "preview_hash": meta.get("preview_hash", ""),
            })
        except Exception:
            pass
    return snaps


def create_snapshot(workflow: dict, name: str, project: str = "default",
                    description: str = "", tags: list | None = None) -> dict:
    ensure_dir()

    snap_id   = f"{int(time.time() * 1000)}_{hashlib.md5(name.encode()).hexdigest()[:6]}"
    node_count = len(workflow) if isinstance(workflow, dict) else 0

    # Workflow'un basit hash'i (değişiklik tespiti için)
    wf_str     = json.dumps(workflow, sort_keys=True)
    wf_hash    = hashlib.md5(wf_str.encode()).hexdigest()

    snap = {
        "id":           snap_id,
        "name":         name,
        "project":      project,
        "description":  description,
        "tags":         tags or [],
        "created_at":   datetime.now().isoformat(),
        "node_count":   node_count,
        "preview_hash": wf_hash,
        "workflow":     workflow,
    }

    snapshot_path(snap_id).write_text(json.dumps(snap, indent=2))

    # Eski snapshot'ları temizle (proje başına MAX_SNAPSHOTS)
    project_snaps = [s for s in list_snapshots() if s["project"] == project]
    if len(project_snaps) > MAX_SNAPSHOTS:
        oldest = project_snaps[MAX_SNAPSHOTS:]
        for old in oldest:
            p = snapshot_path(old["id"])
            if p.exists():
                p.unlink()

    print(f"[Snapshot] ✓ Kaydedildi: '{name}' ({node_count} node)")
    return {"id": snap_id, "name": name, "node_count": node_count}


def get_snapshot(snap_id: str) -> dict | None:
    p = snapshot_path(snap_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def delete_snapshot(snap_id: str) -> bool:
    p = snapshot_path(snap_id)
    if p.exists():
        p.unlink()
        return True
    return False


def rename_snapshot(snap_id: str, new_name: str, description: str = None,
                    tags: list = None) -> bool:
    snap = get_snapshot(snap_id)
    if not snap:
        return False
    snap["name"] = new_name
    if description is not None:
        snap["description"] = description
    if tags is not None:
        snap["tags"] = tags
    snapshot_path(snap_id).write_text(json.dumps(snap, indent=2))
    return True


def diff_snapshots(id_a: str, id_b: str) -> dict:
    """İki snapshot arasındaki farkı hesapla (node eklenmiş/silinmiş/değişmiş)."""
    a = get_snapshot(id_a)
    b = get_snapshot(id_b)
    if not a or not b:
        return {"error": "Snapshot bulunamadı"}

    wf_a = a.get("workflow", {})
    wf_b = b.get("workflow", {})

    keys_a = set(wf_a.keys())
    keys_b = set(wf_b.keys())

    added   = list(keys_b - keys_a)
    removed = list(keys_a - keys_b)
    changed = []

    for key in keys_a & keys_b:
        node_a = wf_a[key]
        node_b = wf_b[key]
        if json.dumps(node_a, sort_keys=True) != json.dumps(node_b, sort_keys=True):
            changed.append({
                "node_id":    key,
                "class_type": node_b.get("class_type", ""),
            })

    return {
        "snapshot_a": {"id": id_a, "name": a["name"], "created_at": a["created_at"]},
        "snapshot_b": {"id": id_b, "name": b["name"], "created_at": b["created_at"]},
        "added":      len(added),
        "removed":    len(removed),
        "changed":    len(changed),
        "details":    {"added": added, "removed": removed, "changed": changed},
    }


# ── API Endpoint'leri ──────────────────────────────────────────────────────

@server.PromptServer.instance.routes.get("/smart_manager/snapshots")
async def list_snaps(request):
    project = request.rel_url.query.get("project")
    return web.json_response(list_snapshots(project))


@server.PromptServer.instance.routes.post("/smart_manager/snapshots")
async def create_snap(request):
    try:
        data     = await request.json()
        workflow = data.get("workflow", {})
        name     = data.get("name", f"Snapshot {datetime.now().strftime('%d %b %H:%M')}")
        project  = data.get("project", "default")
        desc     = data.get("description", "")
        tags     = data.get("tags", [])
        if not workflow:
            return web.json_response({"error": "Workflow boş"}, status=400)
        result = create_snapshot(workflow, name, project, desc, tags)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/smart_manager/snapshots/{snap_id}")
async def get_snap(request):
    snap = get_snapshot(request.match_info["snap_id"])
    if not snap:
        return web.json_response({"error": "Bulunamadı"}, status=404)
    return web.json_response(snap)


@server.PromptServer.instance.routes.delete("/smart_manager/snapshots/{snap_id}")
async def delete_snap(request):
    ok = delete_snapshot(request.match_info["snap_id"])
    return web.json_response({"deleted": ok})


@server.PromptServer.instance.routes.patch("/smart_manager/snapshots/{snap_id}")
async def update_snap(request):
    try:
        data = await request.json()
        ok   = rename_snapshot(
            request.match_info["snap_id"],
            data.get("name", ""),
            data.get("description"),
            data.get("tags"),
        )
        return web.json_response({"updated": ok})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/smart_manager/snapshots/diff/{id_a}/{id_b}")
async def diff_snaps(request):
    result = diff_snapshots(request.match_info["id_a"], request.match_info["id_b"])
    return web.json_response(result)


@server.PromptServer.instance.routes.get("/smart_manager/snapshot_projects")
async def list_projects(request):
    snaps    = list_snapshots()
    projects = list({s["project"] for s in snaps})
    return web.json_response(sorted(projects))
