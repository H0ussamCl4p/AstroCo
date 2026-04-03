from __future__ import annotations

import asyncio
import base64
import io
import json
import re
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import websockets
import tempfile
import os

# Suppress HuggingFace cache warnings on Windows before loading faster-whisper
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

import ollama
from kokoro_onnx import Kokoro
from faster_whisper import WhisperModel

from rag import RagIndex, embed_query, format_hits
from pure_memory import MemoryManager

# Project root (parent of backend/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent


LLM_MODEL = "gemma3:1b"
TTS_MODEL_PATH = str(PROJECT_ROOT / "models" / "kokoro-v1.0.onnx")
TTS_VOICES_PATH = str(PROJECT_ROOT / "models" / "voices-v1.0.bin")
TTS_VOICE = "af_sarah"
TTS_SPEED = 1.2  # Faster for snappier VR feel + reduced latency
TTS_LANG = "en-us"

RAG_INDEX_PATH = str(PROJECT_ROOT / "data" / "rag_index.json")
RAG_EMBED_MODEL = "nomic-embed-text"
RAG_TOP_K = 4
RAG_MIN_SCORE = 0.18

WS_HOST = "0.0.0.0"
WS_PORT = 8765


def _ensure_kokoro_files() -> None:
    missing = [
        str(p)
        for p in [Path(TTS_MODEL_PATH), Path(TTS_VOICES_PATH)]
        if not p.exists()
    ]
    if missing:
        raise FileNotFoundError(
            "Missing Kokoro model files: "
            f"{', '.join(missing)}. Place kokoro-v1.0.onnx and voices-v1.0.bin next to vr_backend.py."
        )


def _wav_bytes(samples: np.ndarray, *, sample_rate: int) -> bytes:
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


@dataclass
class AppState:
    kokoro: Kokoro
    rag_index: RagIndex | None
    memory: MemoryManager
    whisper: WhisperModel | None  # Lazy-loaded on first voice request
    tts_cache: dict  # Pre-synthesized common phrases for instant playback


def _build_system_prompt(memory: MemoryManager) -> str:
    return (
        "You are Luna-Chan, a friendly VR guide for space and the Moon. "
        "Keep responses to 1-2 SHORT sentences max. Be direct.\n"
        "IMPORTANT: Start every response with ONE emotion tag: [Happy], [Surprised], [Thinking], [Angry], [Neutral].\n"
        "Example: '[Happy] The moon is beautiful!'\n"
        "No lists, no bullet points, no long explanations. Quick and fun.\n"
        "Use [SAVE: <fact>] ONLY for user facts (name, preferences). Never for general knowledge.\n"
        "Prefer facts from retrieved KB context. If unsure, say so briefly.\n"
        f"\n[Memory]\n{memory.get_context_string()}\n"
    )


def _chat_once(*, messages: list[dict[str, Any]]) -> str:
    resp = ollama.chat(model=LLM_MODEL, messages=messages, stream=False)
    msg = resp.get("message") or {}
    return str(msg.get("content") or "").strip()


async def _handle_message(state: AppState, msg: dict[str, Any]):
    mtype = str(msg.get("type") or "").strip()

    if mtype == "ping":
        yield {"type": "pong", "t": time.time()}
        return

    if mtype == "start_game":
        assistant_text = "[Happy] Hello! Welcome to the Astronomy Festival. Are you ready to discover the universe? Please select an option from the menu."
        # Use pre-cached TTS if available
        cache_key = "start_game"
        if cache_key in state.tts_cache:
            wav = state.tts_cache[cache_key]
        else:
            clean_text = re.sub(r'\[.*?\]', '', assistant_text).strip()
            samples, sample_rate = state.kokoro.create(
                clean_text, voice=TTS_VOICE, speed=TTS_SPEED, lang=TTS_LANG
            )
            wav = _wav_bytes(samples, sample_rate=sample_rate)
        yield {
            "type": "assistant_reply",
            "text": assistant_text,
            "wav_b64": base64.b64encode(wav).decode("ascii"),
        }
        return

    if mtype == "menu_select":
        scene = str(msg.get("scene") or "").strip()
        if scene:
            # Scene narration (keep it short for VR comfort)
            scene_narration = {
                "solar": "[Surprised] Welcome to the Solar System! This hologram shows the Sun and the planets in motion.",
                "gateway": "[Happy] This is Lunar Gateway, a space station planned to orbit the Moon and support future missions.",
                "yutu": "[Happy] Meet Yutu-2! It's a lunar rover exploring the far side of the Moon.",
            }

            if scene == "chat":
                assistant_text = "[Happy] Awesome, let's chat! What would you like to ask me about space?"
                cache_key = "chat_mode"
            elif scene == "main":
                assistant_text = "[Thinking] What else would you like to explore?"
                cache_key = "back_menu"
            else:
                assistant_text = scene_narration.get(scene) or f"[Happy] Great choice! Let's explore {scene}."
                cache_key = f"scene_{scene}"

            if cache_key in state.tts_cache:
                wav = state.tts_cache[cache_key]
                sample_rate = 24000  # Kokoro default; used only for info
            else:
                clean_text = re.sub(r"\[.*?\]", "", assistant_text).strip()
                samples, sample_rate = state.kokoro.create(
                    clean_text, voice=TTS_VOICE, speed=TTS_SPEED, lang=TTS_LANG
                )
                wav = _wav_bytes(samples, sample_rate=sample_rate)
                state.tts_cache[cache_key] = wav
            yield {
                "type": "assistant_reply",
                "text": assistant_text,
                "wav_b64": base64.b64encode(wav).decode("ascii"),
                "sample_rate": int(sample_rate),
                "scene": scene
            }
        else:
            yield {"type": "error", "error": "scene missing"}
        return

    user_text = ""
    mode = str(msg.get("mode") or "chat").strip()

    if mtype == "user_text":
        user_text = str(msg.get("text") or "").strip()
    elif mtype == "voice_audio":
        audio_b64 = str(msg.get("b64") or "")
        if not audio_b64:
            yield {"type": "error", "error": "audio missing"}
            return
            
        audio_data = base64.b64decode(audio_b64)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as f:
            f.write(audio_data)
            tmp_path = f.name
        
        # Lazy-load whisper on first voice request
        if state.whisper is None:
            print("[whisper] Loading faster-whisper model (tiny.en) on CPU...")
            state.whisper = WhisperModel("tiny.en", device="cpu", compute_type="int8")
            print("[whisper] Model loaded!")
            
        try:
            segments, info = state.whisper.transcribe(tmp_path, beam_size=1)
            user_text = "".join([segment.text for segment in segments]).strip()
            print(f"[whisper] Recognized: {user_text}")
        except Exception as e:
            user_text = ""
            print("Whisper error:", e)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
                
        if not user_text:
            yield {"type": "error", "error": "Could not recognize audio."}
            return
    else:
        yield {"type": "error", "error": "unsupported message type"}
        return

    if not user_text:
        yield {"type": "error", "error": "text missing"}
        return

    # === LATENCY OPTIMIZATION: Parallel RAG retrieval ===
    # Run RAG embedding in a thread pool so it doesn't block the event loop
    retrieved_context = ""
    if state.rag_index is not None:
        try:
            loop = asyncio.get_event_loop()
            q_emb = await loop.run_in_executor(
                None, lambda: embed_query(text=user_text, embed_model=RAG_EMBED_MODEL)
            )
            hits = state.rag_index.search(
                q_emb,
                query_text=user_text,
                k=RAG_TOP_K,
                min_score=RAG_MIN_SCORE,
            )
            formatted = format_hits(hits)
            if formatted:
                retrieved_context = (
                    "[Retrieved context from local knowledge base]\n"
                    + formatted
                    + "\n\nRules: Use the retrieved context as your source of truth. Do NOT guess dates, outcomes, or mission status. "
                    "If a date/status is not present in the retrieved context, say you're not sure and that schedules can change."
                )
        except Exception:
            retrieved_context = ""

    system_prompt = _build_system_prompt(state.memory)

    # Light mode hint for tours.
    mode_hint = ""
    if mode:
        mode_hint = f"The current VR mode is: {mode}.\n"

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {
            "role": "system",
            "content": "For VR comfort: keep sentences short and avoid long lists.",
        },
    ]
    if mode_hint:
        messages.append({"role": "system", "content": mode_hint})
    if retrieved_context:
        messages.append({"role": "system", "content": retrieved_context})
    messages.append({"role": "user", "content": user_text})

    # === LATENCY OPTIMIZATION: Filler word for perceived speed ===
    # Send an instant "thinking" filler before LLM starts (per Agora/Hamming best practices)
    if "filler_thinking" in state.tts_cache:
        yield {
            "type": "assistant_reply",
            "text": "...",
            "wav_b64": base64.b64encode(state.tts_cache["filler_thinking"]).decode("ascii"),
        }

    # === LATENCY OPTIMIZATION: Limit max tokens + keep_alive for hot model ===
    resp = ollama.chat(
        model=LLM_MODEL,
        messages=messages,
        stream=True,
        options={"num_predict": 60, "temperature": 0.7, "top_p": 0.85},  # Tighter generation = faster
        keep_alive="30m",  # Keep model hot in RAM, avoid cold-start reload
    )
    sentence_buf = ""
    full_text_accum = ""

    in_think_block = False  # Track <think> blocks to skip them

    for chunk in resp:
        text = chunk.get("message", {}).get("content", "")
        
        # === Filter out Qwen3 <think> blocks in real-time ===
        if '<think>' in text:
            in_think_block = True
            text = text[:text.index('<think>')]
        if in_think_block:
            if '</think>' in text:
                text = text[text.index('</think>') + len('</think>'):]
                in_think_block = False
            else:
                continue  # Skip all tokens inside <think> block
        
        if not text:
            continue
        
        # print("LLM CHUNK:", repr(text))
        sentence_buf += text
        
        match = re.search(r'([.!?,\n])(\s+|$)', sentence_buf)
        if match:
            idx = match.end()
            sentence = sentence_buf[:idx].strip()
            sentence_buf = sentence_buf[idx:]
            
            if len(sentence) > 2:
                if not full_text_accum:
                    full_text_accum += sentence
                else:
                    full_text_accum += " " + sentence
                    
                try:
                    clean_sentence = re.sub(r'\[.*?\]', '', sentence).strip()
                    if clean_sentence:
                        samples, sample_rate = state.kokoro.create(clean_sentence, voice=TTS_VOICE, speed=TTS_SPEED, lang=TTS_LANG)
                        wav = _wav_bytes(samples, sample_rate=sample_rate)
                        yield {
                            "type": "assistant_reply",
                            "text": full_text_accum,
                            "wav_b64": base64.b64encode(wav).decode("ascii"),
                            "sample_rate": int(sample_rate)
                        }
                    else:
                        yield {"type": "assistant_reply", "text": full_text_accum}
                except Exception as e:
                    print(f"TTS ERROR: {e}")
                    yield {"type": "assistant_reply", "text": full_text_accum}
                    
    if len(sentence_buf.strip()) > 2:
        sentence = sentence_buf.strip()
        if not full_text_accum:
            full_text_accum += sentence
        else:
            full_text_accum += " " + sentence
            
        try:
            clean_sentence = re.sub(r'\[.*?\]', '', sentence).strip()
            if clean_sentence:
                samples, sample_rate = state.kokoro.create(clean_sentence, voice=TTS_VOICE, speed=TTS_SPEED, lang=TTS_LANG)
                wav = _wav_bytes(samples, sample_rate=sample_rate)
                yield {
                    "type": "assistant_reply",
                    "text": full_text_accum,
                    "wav_b64": base64.b64encode(wav).decode("ascii"),
                    "sample_rate": int(sample_rate)
                }
            else:
                yield {"type": "assistant_reply", "text": full_text_accum}
        except Exception as e:
             print(f"TTS ERROR final: {e}")
             yield {"type": "assistant_reply", "text": full_text_accum}


async def _ws_handler(websocket):
    # Lazily create shared state once.
    if not hasattr(_ws_handler, "state"):
        _ensure_kokoro_files()
        kokoro = Kokoro(TTS_MODEL_PATH, TTS_VOICES_PATH)

        rag_index = None
        try:
            p = Path(RAG_INDEX_PATH)
            if p.exists():
                rag_index = RagIndex.load(p)
                print(f"[rag] loaded index: {p}")
            else:
                print(f"[rag] index not found: {p} (RAG disabled)")
        except Exception as exc:
            print(f"[rag] disabled (failed to load index): {exc}")

        mem = MemoryManager()
        
        # Whisper is lazy-loaded on first voice request for faster boot
        whisper = None
        
        # === LATENCY OPTIMIZATION: Pre-cache common TTS phrases ===
        print("[tts] Pre-caching common responses...")
        tts_cache = {}
        cache_phrases = {
            "start_game": "Hello! Welcome to the Astronomy Festival. Are you ready to discover the universe? Please select an option from the menu.",
            "chat_mode": "Awesome, let's chat! What would you like to ask me about space?",
            "back_menu": "What else would you like to explore?",
            "scene_solar": "Welcome to the Solar System! This hologram shows the Sun and the planets in motion.",
            "scene_gateway": "This is Lunar Gateway, a space station planned to orbit the Moon and support future missions.",
            "scene_yutu": "Meet Yutu-2! It's a lunar rover exploring the far side of the Moon.",
            "filler_thinking": "Hmm, let me think.",
        }
        for key, phrase in cache_phrases.items():
            try:
                samples, sample_rate = kokoro.create(phrase, voice=TTS_VOICE, speed=TTS_SPEED, lang=TTS_LANG)
                tts_cache[key] = _wav_bytes(samples, sample_rate=sample_rate)
            except Exception as e:
                print(f"[tts] Failed to cache '{key}': {e}")
        print(f"[tts] Cached {len(tts_cache)} phrases for instant playback")
        print("[ready] Server is ready! Accepting connections...")
        
        _ws_handler.state = AppState(kokoro=kokoro, rag_index=rag_index, memory=mem, whisper=whisper, tts_cache=tts_cache)

    state: AppState = _ws_handler.state

    async for raw in websocket:
        try:
            msg = json.loads(raw)
            if not isinstance(msg, dict):
                raise ValueError("message must be a JSON object")
            async for reply in _handle_message(state, msg):
                try:
                    await websocket.send(json.dumps(reply, ensure_ascii=False))
                except websockets.exceptions.ConnectionClosed:
                    print("[ws] Client disconnected during send, stopping.")
                    return
        except websockets.exceptions.ConnectionClosed:
            print("[ws] Client disconnected.")
            return
        except Exception as exc:
            try:
                reply = {"type": "error", "error": str(exc)}
                await websocket.send(json.dumps(reply, ensure_ascii=False))
            except websockets.exceptions.ConnectionClosed:
                return


async def main() -> None:
    print(f"[vr_backend] ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(
        _ws_handler, WS_HOST, WS_PORT,
        max_size=8 * 1024 * 1024,
        ping_interval=60,
        ping_timeout=120,
    ):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
