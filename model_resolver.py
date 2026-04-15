"""
Model Resolver — Backend
Workflow'daki modelleri tespit eder, akıllı fuzzy arama ile bulur, indirir.

Arama motoru (KNOWN_HF yok):
  1. Dosya adını normalize et → anlamlı token'lara böl
  2. HuggingFace + CivitAI'da paralel ara
  3. Her sonucu 4 kritere göre skorla:
       - Token örtüşmesi  (adın kaç parçası eşleşti)
       - Tam dosya adı eşleşmesi  (HEAD isteği ile doğrula)
       - Download sayısı  (popüler = güvenilir)
       - Model tipi uyumu (klasör adıyla örtüşüyor mu)
  4. En iyi 3 adayı döndür, kullanıcı seçsin
"""

import json, re, os, threading, urllib.request, urllib.parse, concurrent.futures
from pathlib import Path
import server
from aiohttp import web

# ── Sabitler ──────────────────────────────────────────────────────────────

MODEL_FIELDS = {
    "ckpt_name":          "checkpoints",
    "vae_name":           "vae",
    "lora_name":          "loras",
    "control_net_name":   "controlnet",
    "upscale_model_name": "upscale_models",
    "clip_name":          "clip",
    "clip_name1":         "clip",
    "clip_name2":         "clip",
    "ipadapter":          "ipadapter",
    "model_name":         "checkpoints",
    "embedding_name":     "embeddings",
    "unet_name":          "unet",
    "diffusion_model":    "diffusion_models",
}

# Klasör adı → CivitAI model type eşlemesi (arama filtrelemek için)
FOLDER_TO_CIVITAI_TYPE = {
    "checkpoints":    "Checkpoint",
    "loras":          "LORA",
    "vae":            "VAE",
    "controlnet":     "Controlnet",
    "upscale_models": "Upscaler",
    "embeddings":     "TextualInversion",
}

# İndirme ilerlemesi { "folder/name": {status, percent, downloaded_mb, error} }
_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()


# ── Akıllı isim normalizer ────────────────────────────────────────────────

def normalize_name(filename: str) -> tuple[str, list[str]]:
    """
    Dosya adını arama sorgusuna ve token listesine çevirir.

    Örnek:
      "epicrealism_naturalSinRC1VAE.safetensors"
        → query: "epicrealism naturalsin rc1 vae"
        → tokens: ["epicrealism", "naturalsin", "rc1", "vae"]

      "control_v11p_sd15_openpose.pth"
        → query: "control v11p sd15 openpose"
        → tokens: ["control", "v11p", "sd15", "openpose"]
    """
    # Uzantıyı kaldır
    stem = re.sub(r'\.(safetensors|ckpt|pth|bin|pt|gguf)$', '', filename, flags=re.I)

    # camelCase → boşluk: "naturalSinRC1" → "natural Sin RC1"
    stem = re.sub(r'([a-z])([A-Z])', r'\1 \2', stem)
    stem = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', stem)

    # Alt çizgi, tire, nokta → boşluk
    stem = re.sub(r'[_\-\.]+', ' ', stem)

    # Küçük harfe çevir, fazla boşlukları temizle
    query = re.sub(r'\s+', ' ', stem).strip().lower()

    # Token listesi (2 karakterden kısa olanları at — "v1" gibi versiyonlar kalır ama "a" gitmez)
    tokens = [t for t in query.split() if len(t) >= 2]

    return query, tokens


def token_overlap_score(tokens_a: list[str], tokens_b: list[str]) -> float:
    """
    İki token listesi arasındaki örtüşme oranı.
    Kısmi eşleşmeleri de yakalar: "epicreal" ∈ "epicrealism"
    """
    if not tokens_a or not tokens_b:
        return 0.0

    matched = 0
    for ta in tokens_a:
        for tb in tokens_b:
            if ta == tb:
                matched += 2          # Tam eşleşme → tam puan
            elif ta in tb or tb in ta:
                matched += 1          # Kısmi eşleşme → yarım puan
            break

    return matched / (len(tokens_a) * 2)


# ── HuggingFace arama ─────────────────────────────────────────────────────

_HF_HEADERS = {"User-Agent": "ComfyUI-SmartManager/1.0"}


def _hf_search(query: str, limit: int = 8) -> list[dict]:
    """HuggingFace model API araması. Ham sonuçları döndürür."""
    url = (f"https://huggingface.co/api/models"
           f"?search={urllib.parse.quote(query)}&limit={limit}"
           f"&sort=downloads&direction=-1&filter=diffusers")
    try:
        req = urllib.request.Request(url, headers=_HF_HEADERS)
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception:
        return []


def _hf_repo_files(repo_id: str) -> list[str]:
    """Bir HF repo'sunun dosya listesini çek."""
    url = f"https://huggingface.co/api/models/{repo_id}"
    try:
        req = urllib.request.Request(url, headers=_HF_HEADERS)
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read())
        return [s["rfilename"] for s in data.get("siblings", [])]
    except Exception:
        return []


def _hf_head_check(url: str) -> bool:
    """URL'nin gerçekten var olduğunu HEAD ile doğrula."""
    try:
        req = urllib.request.Request(url, method="HEAD", headers=_HF_HEADERS)
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def search_huggingface(filename: str, folder: str) -> list[dict]:
    """
    HuggingFace'de akıllı arama yap, skorlanmış aday listesi döndür.
    Her aday: {score, url, repo_id, file_name, downloads, source}
    """
    query, query_tokens = normalize_name(filename)
    results = _hf_search(query)

    candidates = []

    for repo in results:
        repo_id   = repo.get("id") or repo.get("modelId", "")
        downloads = repo.get("downloads", 0)

        if not repo_id:
            continue

        # Repo adının token'ları
        repo_query, repo_tokens = normalize_name(repo_id.replace("/", " "))

        # 1. Token örtüşme skoru (0–1)
        name_score = token_overlap_score(query_tokens, repo_tokens)

        # Düşük örtüşmeli repo'ları erken at
        if name_score < 0.1:
            continue

        # 2. Repo'nun dosyalarını çek, tam isim eşleşmesi ara
        files = _hf_repo_files(repo_id)

        # Tam isim eşleşmesi
        exact_match = filename in files
        # Stem eşleşmesi: "model.safetensors" yerine "model.ckpt" de kabul
        stem = re.sub(r'\.(safetensors|ckpt|pth|bin|pt)$', '', filename, flags=re.I)
        stem_matches = [f for f in files if f.startswith(stem) and
                        f.endswith(('.safetensors', '.ckpt', '.pth', '.bin', '.pt'))]

        if exact_match:
            target_file = filename
            file_score  = 1.0
        elif stem_matches:
            target_file = stem_matches[0]
            file_score  = 0.7
        else:
            # Repo'daki tüm model dosyalarında token eşleşmesi ara
            model_files = [f for f in files
                           if f.endswith(('.safetensors', '.ckpt', '.pth', '.bin', '.pt'))]
            best_file = None
            best_fscore = 0.0
            for mf in model_files:
                _, mf_tokens = normalize_name(mf)
                fs = token_overlap_score(query_tokens, mf_tokens)
                if fs > best_fscore:
                    best_fscore = fs
                    best_file   = mf
            if best_file and best_fscore > 0.3:
                target_file = best_file
                file_score  = best_fscore * 0.5   # Dolaylı eşleşme cezası
            else:
                continue  # Bu repo'da uygun dosya yok

        # 3. Model tipi uyumu — klasör adı repo'da geçiyor mu?
        type_score = 0.0
        folder_hint = folder.rstrip("s")  # "checkpoints" → "checkpoint"
        if folder_hint in repo_id.lower() or folder_hint in query:
            type_score = 0.2

        # 4. Popülerlik skoru (log normalize, max 0.2)
        import math
        pop_score = min(math.log10(max(downloads, 1)) / 7, 0.2)

        total_score = name_score + file_score + type_score + pop_score

        candidates.append({
            "score":     round(total_score, 3),
            "url":       f"https://huggingface.co/{repo_id}/resolve/main/{target_file}",
            "repo_id":   repo_id,
            "file_name": target_file,
            "downloads": downloads,
            "source":    "huggingface",
            "exact":     exact_match,
        })

    # Skora göre sırala, en iyi 3'ü döndür
    candidates.sort(key=lambda x: -x["score"])
    return candidates[:3]


# ── CivitAI arama ─────────────────────────────────────────────────────────

def search_civitai(filename: str, folder: str, token: str | None = None) -> list[dict]:
    """CivitAI'da akıllı arama yap, skorlanmış aday listesi döndür."""
    query, query_tokens = normalize_name(filename)

    params = {"query": query, "limit": 8, "sort": "Most Downloaded"}
    civitai_type = FOLDER_TO_CIVITAI_TYPE.get(folder)
    if civitai_type:
        params["types"] = civitai_type

    url = f"https://civitai.com/api/v1/models?{urllib.parse.urlencode(params)}"
    headers = {"User-Agent": "ComfyUI-SmartManager/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
    except Exception:
        return []

    candidates = []

    for model in data.get("items", []):
        model_name  = model.get("name", "")
        downloads   = model.get("stats", {}).get("downloadCount", 0)
        versions    = model.get("modelVersions", [])
        if not versions:
            continue

        _, model_tokens = normalize_name(model_name)
        name_score = token_overlap_score(query_tokens, model_tokens)
        if name_score < 0.1:
            continue

        # En uygun versiyonun dosyasını bul
        best_file   = None
        best_fscore = 0.0
        best_version = None

        for version in versions:
            for f in version.get("files", []):
                fname = f.get("name", "")
                if not fname:
                    continue
                _, f_tokens = normalize_name(fname)
                fs = token_overlap_score(query_tokens, f_tokens)

                # Tam dosya adı eşleşmesi bonus
                if fname == filename:
                    fs = 1.0

                if fs > best_fscore:
                    best_fscore  = fs
                    best_file    = f
                    best_version = version

        if not best_file:
            continue

        import math
        pop_score   = min(math.log10(max(downloads, 1)) / 7, 0.2)
        total_score = name_score + best_fscore * 0.6 + pop_score

        candidates.append({
            "score":        round(total_score, 3),
            "url":          best_file.get("downloadUrl", ""),
            "repo_id":      f"civitai/{model.get('id')}",
            "file_name":    best_file.get("name", ""),
            "file_size_mb": round((best_file.get("sizeKB", 0) or 0) / 1024, 1),
            "downloads":    downloads,
            "source":       "civitai",
            "exact":        best_file.get("name") == filename,
            "model_name":   model_name,
            "version_name": best_version.get("name", "") if best_version else "",
            "thumbnail":    (best_version.get("images") or [{}])[0].get("url") if best_version else None,
        })

    candidates.sort(key=lambda x: -x["score"])
    return candidates[:3]


# ── Ana arama fonksiyonu ───────────────────────────────────────────────────

def smart_search(filename: str, folder: str, civitai_token: str | None = None) -> list[dict]:
    """
    HuggingFace ve CivitAI'da paralel arama yapar,
    tüm adayları birleşik skor sıralamasıyla döndürür.

    Dönen liste: en iyi 5 aday, her biri:
    {score, url, file_name, source, downloads, exact, ...}
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        hf_future  = ex.submit(search_huggingface, filename, folder)
        civ_future = ex.submit(search_civitai, filename, folder, civitai_token)

        hf_results  = hf_future.result()
        civ_results = civ_future.result()

    # Birleştir, skora göre sırala
    # CivitAI sonuçlarına hafif bir bonus ver (token gerektiriyorsa download daha güvenilir)
    for c in civ_results:
        c["score"] = round(c["score"] * 1.05, 3)

    all_results = hf_results + civ_results
    all_results.sort(key=lambda x: (-x["exact"], -x["score"]))

    # URL'si olmayanları ve düşük skorluları at
    filtered = [r for r in all_results if r.get("url") and r["score"] > 0.15]
    return filtered[:5]


def get_comfyui_root() -> Path:
    return Path(__file__).parent.parent.parent.parent


def get_models_dir() -> Path:
    return get_comfyui_root() / "models"


# ── Workflow parsing ───────────────────────────────────────────────────────

def parse_workflow(workflow: dict) -> dict[str, list[str]]:
    """Workflow dict'inden {klasör: [model_adları]} döndürür."""
    found: dict[str, set] = {}
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        for field, folder in MODEL_FIELDS.items():
            val = inputs.get(field)
            if isinstance(val, str) and val.strip():
                found.setdefault(folder, set()).add(val.strip())
    return {k: sorted(v) for k, v in found.items()}


def model_exists(name: str, folder: str) -> bool:
    return (get_models_dir() / folder / name).exists()


def model_size_mb(name: str, folder: str) -> float | None:
    p = get_models_dir() / folder / name
    if p.exists():
        return round(p.stat().st_size / 1024 / 1024, 1)
    return None


# ── HuggingFace arama + indirme ────────────────────────────────────────────

def resolve_hf_url(name: str) -> str | None:
    if name in KNOWN_HF:
        repo, fname = KNOWN_HF[name]
        return f"https://huggingface.co/{repo}/resolve/main/{fname}"

    base = name.replace(".safetensors", "").replace(".ckpt", "").replace(".pth", "").replace(".bin", "")
    try:
        url = f"https://huggingface.co/api/models?search={urllib.parse.quote(base)}&limit=5"
        req = urllib.request.Request(url, headers={"User-Agent": "ComfyUI-SmartManager/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            results = json.loads(r.read())
        for result in results:
            repo_id = result.get("modelId", "")
            if not repo_id:
                continue
            candidate = f"https://huggingface.co/{repo_id}/resolve/main/{name}"
            try:
                chk = urllib.request.Request(candidate, method="HEAD",
                                             headers={"User-Agent": "ComfyUI-SmartManager/1.0"})
                with urllib.request.urlopen(chk, timeout=5) as cr:
                    if cr.status == 200:
                        return candidate
            except Exception:
                pass
    except Exception:
        pass
    return None


def _download_thread(name: str, folder: str, url: str):
    key = f"{folder}/{name}"
    dest = get_models_dir() / folder / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")

    with _progress_lock:
        _progress[key] = {"status": "downloading", "percent": 0,
                          "downloaded_mb": 0, "total_mb": 0, "error": None}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ComfyUI-SmartManager/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            total = int(r.headers.get("Content-Length", 0))
            total_mb = round(total / 1024 / 1024, 1)
            downloaded = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    with _progress_lock:
                        _progress[key]["downloaded_mb"] = round(downloaded / 1024 / 1024, 1)
                        _progress[key]["total_mb"] = total_mb
                        if total:
                            _progress[key]["percent"] = round(downloaded / total * 100, 1)
        tmp.rename(dest)
        with _progress_lock:
            _progress[key]["status"] = "done"
            _progress[key]["percent"] = 100
        print(f"[SmartManager] ✓ İndirildi: {key}")
    except Exception as e:
        if tmp.exists():
            tmp.unlink()
        with _progress_lock:
            _progress[key]["status"] = "error"
            _progress[key]["error"] = str(e)
        print(f"[SmartManager] ✗ İndirme hatası ({key}): {e}")


# ── API Endpoint'leri ──────────────────────────────────────────────────────

@server.PromptServer.instance.routes.post("/smart_manager/analyze")
async def analyze_workflow(request):
    try:
        data = await request.json()
        workflow = data.get("workflow", {})
        all_models = parse_workflow(workflow)
        result = []
        for folder, names in all_models.items():
            for name in names:
                exists = model_exists(name, folder)
                result.append({
                    "name":    name,
                    "folder":  folder,
                    "exists":  exists,
                    "size_mb": model_size_mb(name, folder),
                })
        return web.json_response({"models": result, "total": len(result)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/smart_manager/find_url")
async def find_url(request):
    """
    Akıllı arama: HF + CivitAI paralel, skorlanmış aday listesi döndürür.
    Yanıt: { candidates: [{score, url, source, file_name, exact, ...}] }
    """
    try:
        data   = await request.json()
        name   = data.get("name", "")
        folder = data.get("folder", "checkpoints")

        # Config'den CivitAI token'ı al
        try:
            from py.civitai import get_civitai_token
            token = get_civitai_token()
        except Exception:
            token = None

        candidates = smart_search(name, folder, token)

        return web.json_response({
            "candidates": candidates,
            "query":      normalize_name(name)[0],   # debug için normalize edilmiş sorgu
            "found":      len(candidates) > 0,
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/smart_manager/download")
async def start_download(request):
    try:
        data   = await request.json()
        name   = data.get("name", "")
        folder = data.get("folder", "")
        url    = data.get("url", "")
        if not all([name, folder, url]):
            return web.json_response({"error": "name, folder, url gerekli"}, status=400)
        key = f"{folder}/{name}"
        if _progress.get(key, {}).get("status") == "downloading":
            return web.json_response({"status": "already_running"})
        threading.Thread(target=_download_thread, args=(name, folder, url), daemon=True).start()
        return web.json_response({"status": "started", "key": key})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/smart_manager/download_progress")
async def get_progress(request):
    with _progress_lock:
        return web.json_response(dict(_progress))


@server.PromptServer.instance.routes.get("/smart_manager/local_models")
async def list_local_models(request):
    """Lokaldeki tüm modelleri listele."""
    models_dir = get_models_dir()
    result = {}
    for folder in ["checkpoints", "loras", "vae", "controlnet",
                   "upscale_models", "clip", "embeddings", "unet", "ipadapter"]:
        d = models_dir / folder
        if d.exists():
            files = []
            for f in sorted(d.iterdir()):
                if f.is_file() and f.suffix in (".safetensors", ".ckpt", ".pth", ".bin", ".pt"):
                    files.append({"name": f.name, "size_mb": round(f.stat().st_size / 1024 / 1024, 1)})
            result[folder] = files
    return web.json_response(result)
