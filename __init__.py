"""
ComfyUI Smart Manager
=====================
Tek pakette dört özellik:
  1. Model Resolver   — workflow'daki eksik modelleri tespit & indir
  2. CivitAI Browser  — model thumbnail + metadata, tek tıkla indir
  3. Snapshot System  — workflow versiyonlama (kaydet / geri al)
  4. Prompt History   — üretim geçmişi (prompt + çıktı + parametreler)

Kurulum:
    ComfyUI/custom_nodes/comfyui-smart-manager/  klasörüne koy, yeniden başlat.
"""

import importlib, sys, os
sys.path.insert(0, os.path.dirname(__file__))

# Alt modülleri yükle
from py import model_resolver, civitai, snapshot, history

# ComfyUI node sistemi için zorunlu
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./js"

print("[SmartManager] ✓ ComfyUI Smart Manager yüklendi.")
print("[SmartManager]   • Model Resolver  ✓")
print("[SmartManager]   • CivitAI Browser ✓")
print("[SmartManager]   • Snapshot System ✓")
print("[SmartManager]   • Prompt History  ✓")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
