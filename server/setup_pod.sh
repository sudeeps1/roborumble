#!/usr/bin/env bash
# Rebuilds the game server on a fresh RunPod pod (template "RunPod PyTorch", RTX 4090 or any 24 GB+ GPU,
# 80 GB container disk, HTTP port 8000 exposed). About 15-20 minutes, mostly downloads.
#
# From the Mac (the repo is private, so copy it over), with WARP on:
#   tar czf - --exclude=client/node_modules --exclude=server/.venv roborumble | ssh root@<ip> -p <port> 'tar xzf - -C /root'
#   scp -P <port> backups/library-*.tgz root@<ip>:/root/library.tgz      # optional: restore the move library
#   ssh root@<ip> -p <port> 'bash /root/roborumble/server/setup_pod.sh'
# The owner then saves the Hugging Face token (and optional Muse / Anthropic keys) to files on the pod
# themselves, and runs server/start_pod.sh.
set -euo pipefail
cd /root/roborumble
git config --global --add safe.directory /root/roborumble || true

python3 -m venv --system-site-packages /root/venv   # reuses the template's CUDA PyTorch
/root/venv/bin/pip install -q -U pip
/root/venv/bin/pip install -q "kimodo[all] @ git+https://github.com/nv-tlabs/kimodo.git"
/root/venv/bin/pip install -q -r server/requirements.txt sentence-transformers huggingface_hub mujoco scipy

if [ -f /root/library.tgz ] && [ ! -d /root/library ]; then tar xzf /root/library.tgz -C /root && echo "library restored"; fi

# Kimodo's G1 model and the ungated text-encoder adapters (Llama itself needs the HF token first)
/root/venv/bin/python - <<'EOF'
from huggingface_hub import snapshot_download
for r in ["nvidia/Kimodo-G1-RP-v1", "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
          "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"]:
    snapshot_download(r)
print("models downloaded")
EOF

cat <<'EOF'

Done. Next, on the pod:
  1. Save the Hugging Face token (the owner types it):
     mkdir -p ~/.cache/huggingface && read -s -p "HF token: " T && echo -n "$T" > ~/.cache/huggingface/token
  2. Optional keys: same trick into /root/.muse_key and /root/.anthropic_key
  3. bash /root/roborumble/server/start_pod.sh   (first start downloads Llama, ~16 GB)
  4. New public link: https://<pod-id>-8000.proxy.runpod.net  -> update client/.env.local on the laptop
EOF
