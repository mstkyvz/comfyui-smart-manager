# ⚡ ComfyUI Smart Manager

ComfyUI için dört özelliği tek pakette sunan custom node.

![Python](https://img.shields.io/badge/python-3.10+-blue)
![ComfyUI](https://img.shields.io/badge/ComfyUI-compatible-green)
![License](https://img.shields.io/badge/license-MIT-orange)

---

## Özellikler

### 🔍 Model Resolver
- Açık workflow'daki tüm modelleri otomatik tespit eder
- Lokalde hangilerinin eksik olduğunu gösterir
- HuggingFace'de otomatik arar ve tek tıkla indirir
- İndirme ilerlemesini canlı gösterir (%)
- Lokaldeki tüm modelleri klasöre göre listeler

### 🎨 CivitAI Browser
- CivitAI'da model arama (Checkpoint, LoRA, VAE, ControlNet…)
- Thumbnail önizleme ile grid görünüm
- Model detay sayfası (tüm versiyonlar, örnek görseller, taglar)
- API token ile doğrudan indirme
- Sayfalama desteği

### 📸 Snapshot System
- Mevcut workflow'u isimle kaydet
- Proje klasörlerine ayır
- Kayıtlı bir workflow'u tek tıkla geri yükle
- İki snapshot arasında diff görüntüle (kaç node eklendi/silindi/değişti)
- Her proje için max 50 snapshot (otomatik temizleme)

### 📜 Prompt History
- Her üretimi otomatik kaydeder (ek node gerekmez)
- Prompt, checkpoint, steps, CFG, seed, boyut, LoRA'lar
- Çıktı görsellerini önizle
- Metinle arama, durum filtresi
- İstatistikler: toplam üretim, ortalama süre, en çok kullanılan model

---

## Kurulum

```bash
# ComfyUI klasörüne git
cd /path/to/ComfyUI/custom_nodes/

# Repoyu klonla
git clone https://github.com/kullanici_adi/comfyui-smart-manager.git

# ComfyUI'yi yeniden başlat
cd /path/to/ComfyUI
python main.py
```

Kurulum başarılıysa terminalde şunu göreceksin:
```
[SmartManager] ✓ ComfyUI Smart Manager yüklendi.
[SmartManager]   • Model Resolver  ✓
[SmartManager]   • CivitAI Browser ✓
[SmartManager]   • Snapshot System ✓
[SmartManager]   • Prompt History  ✓
```

---

## Kullanım

### Paneli Açmak
- ComfyUI üst menüsündeki **⚡ Smart Manager** butonuna tıkla
- Veya canvas'a **sağ tıkla → Smart Manager**
- Veya klavye kısayolu: **Ctrl+Shift+M**

### CivitAI Token Ayarlamak
Modelleri doğrudan CivitAI'dan indirmek için token gereklidir:

1. [civitai.com](https://civitai.com) → Hesabın → **API Keys**
2. Yeni bir key oluştur, kopyala
3. Smart Manager → CivitAI sekmesi → **🔑 Token** → Yapıştır → Kaydet

Token `config.json` dosyasına kaydedilir (ComfyUI klasöründe, `.gitignore`'a ekle!).

### HuggingFace Token (Opsiyonel)
Bazı gated modeller (FLUX, SDXL vb.) için:
```bash
pip install huggingface_hub
huggingface-cli login
```

---

## Desteklenen Model Alanları

| Node Alanı | Klasör |
|-----------|--------|
| `ckpt_name` | models/checkpoints/ |
| `vae_name` | models/vae/ |
| `lora_name` | models/loras/ |
| `control_net_name` | models/controlnet/ |
| `upscale_model_name` | models/upscale_models/ |
| `clip_name` | models/clip/ |
| `ipadapter` | models/ipadapter/ |
| `unet_name` | models/unet/ |
| `embedding_name` | models/embeddings/ |

---

## Veri Depolama

```
ComfyUI/
├── smart_manager_data/
│   ├── snapshots/     # Workflow snapshot'ları (.json)
│   └── history/       # Üretim geçmişi (.json)
└── custom_nodes/
    └── comfyui-smart-manager/
        └── config.json  # API token'ları (⚠ git'e ekleme!)
```

> **Önemli:** `config.json` dosyasını `.gitignore`'a ekle, token'larını yanlışlıkla paylaşma.

---

## Bilinen Sınırlar

- **CivitAI modelleri** token olmadan indirilemez (model sayfası açılır)
- **Prompt History hook'u** bazı özel ComfyUI kurulumlarında çalışmayabilir; bu durumda frontend manuel kayıt endpoint'ini kullanır
- **Workflow geri yükleme** ComfyUI'nin `loadGraphData` API'sine bağlıdır; bazı çok özel node tiplerinde eksik görsel olabilir

---

## Geliştirme

### Yeni model → HuggingFace eşlemesi eklemek
`py/model_resolver.py` içindeki `KNOWN_HF` sözlüğüne ekle:

```python
KNOWN_HF = {
    "model_adi.safetensors": ("hf-kullanici/repo-adi", "dosya/yolu.safetensors"),
    ...
}
```

### Yeni CivitAI kategori → klasör eşlemesi
`py/civitai.py` içindeki `FOLDER_MAP`'e ekle.

---

## Lisans

MIT License — istediğin gibi kullan, fork'la, geliştir.

---

## Teşekkürler

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — harika platform
- [ComfyUI Manager](https://github.com/ltdrdata/ComfyUI-Manager) — ilham
- [CivitAI](https://civitai.com) — model ekosistemi
