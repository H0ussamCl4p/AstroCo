# AstroCo — Space Festival VR Assistant

A privacy-first, fully local WebXR astronomy assistant powered by an interactive VRM avatar. The project leverages local AI models (Ollama for LLM, Kokoro-ONNX for Text-to-Speech, Faster-Whisper for Speech-to-Text) and a Three.js WebXR frontend to provide a seamless, low-latency virtual reality experience focused on space exploration and astronomy education.

## Project Structure

```
astroco/
├── frontend/               # Vite-powered WebXR 3D frontend
│   ├── index.html          # HTML shell 
│   ├── vite.config.js      # Dev server configuration
│   └── src/                # Three.js, VRM handling, and WebSocket logic
├── backend/                # Python local AI backend
│   ├── vr_backend.py       # Core WebSocket server integrating LLM, TTS, STT
│   ├── rag.py              # Knowledge retrieval engine
│   ├── pure_memory.py      # Long-term conversational memory
│   ├── turboquant.py       # Embedding quantization utilities
│   └── build_rag_index.py  # Script to compile markdown Knowledge Base documents into vector DB
├── models/                 # Heavy model files (Kokoro ONNX, Voice packs, VRM Avatars)
├── assets/                 # 3D assets (GLTF models of the Moon, ISS, JWST)
├── kb/                     # Markdown files serving as the Retrieval-Augmented Generation (RAG) knowledge base
├── data/                   # Generated vector indexes and persistent user memory
├── deploy_azure.sh         # Script to automatically deploy AstroCo to an Azure VPS
└── nginx.conf              # Reverse proxy configuration for secure HTTPS WebSockets on VPS
```

## How to Launch

### 1. Install Dependencies
```bash
# Backend (Python 3.10+)
pip install -r requirements.txt

# Frontend (Node.js)
cd frontend
npm install
```

### 2. Prepare Models
Ensure you have the required heavy models placed in the `models/` directory:
- `kokoro-v1.0.onnx` — Text-to-Speech engine.
- `voices-v1.0.bin` — Voice pack.
- `space-avatar.vrm` — Your 3D avatar file.

### 3. Pull Ollama AI Models
Ensure [Ollama](https://ollama.com/) is installed and running, then pull the required models:
```bash
ollama pull gemma3:1b          # Fast local Language Model
ollama pull nomic-embed-text   # Embedding model for RAG search
```

### 4. Build the RAG Knowledge Base
Process the markdown files in the `kb/` folder into a vector index for the AI to use:
```bash
python backend/build_rag_index.py
```

### 5. Start the Application
Run the backend and frontend simultaneously in two separate terminals.

**Terminal 1:** Start the Python WebSocket server for AI processing
```bash
python backend/vr_backend.py
```

**Terminal 2:** Start the Vite frontend development server
```bash
cd frontend
npm run dev
```

Finally, open `http://localhost:8088` in your browser to interact with AstroCo!
