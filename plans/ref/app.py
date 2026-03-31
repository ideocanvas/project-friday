import os
import sys
import tempfile
import logging
import shutil
from typing import Optional

import uvicorn
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Depends, HTTPException, Form
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import APIKeyHeader
from pydantic import BaseModel
from dotenv import load_dotenv

# --- Audio Processing ---
from pydub import AudioSegment
from pydub.silence import split_on_silence

# --- MLX Imports ---
import mlx_whisper
from mlx_audio.tts.generate import generate_audio

# --- Config ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("MLX-Server")

APP_PORT = int(os.getenv("APP_PORT", "9000"))
API_KEY_ENABLED = os.getenv("API_KEY_ENABLED", "true").lower() != "false"
API_KEYS = set(k.strip() for k in os.getenv("API_KEYS", "").split(',')) if API_KEY_ENABLED else set()

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def get_api_key(api_key: str = Depends(api_key_header)):
    if not API_KEY_ENABLED: return None
    if not api_key or api_key not in API_KEYS:
        raise HTTPException(status_code=401, detail="Invalid API Key")
    return api_key

app = FastAPI()
if os.path.exists("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Helper: Smart Split (For Whisper) ---
def transcribe_smart(file_path, model):
    try:
        sound = AudioSegment.from_file(file_path)
    except Exception as e:
        raise ValueError(f"FFmpeg/Pydub error: {e}")

    chunks = split_on_silence(sound, min_silence_len=500, silence_thresh=-40, keep_silence=200)
    full_text = []
    for chunk in chunks:
        if len(chunk) < 200: continue
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as t:
            chunk.export(t.name, format="wav")
            tn = t.name
        try:
            res = mlx_whisper.transcribe(tn, path_or_hf_repo=model)
            if res["text"].strip(): full_text.append(res["text"].strip())
        finally:
            if os.path.exists(tn): os.unlink(tn)
    return " ".join(full_text)

# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def read_root():
    try:
        with open("index.html", "r", encoding="utf-8") as f: return HTMLResponse(content=f.read())
    except: return HTMLResponse(content="<h1>MLX Audio Server</h1>")

@app.post("/transcribe", dependencies=[Depends(get_api_key)])
async def transcribe_endpoint(
    audio_file: UploadFile = File(...),
    smart_split: bool = Form(False),
    model: str = Form("mlx-community/whisper-large-v2-mlx")
):
    tmp_path = None
    try:
        suffix = os.path.splitext(audio_file.filename)[1] or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await audio_file.read())
            tmp_path = tmp.name
        
        if smart_split:
            text = transcribe_smart(tmp_path, model)
        else:
            res = mlx_whisper.transcribe(tmp_path, path_or_hf_repo=model)
            text = res["text"]
        
        os.unlink(tmp_path)
        return {"text": text}
    except Exception as e:
        if tmp_path and os.path.exists(tmp_path): os.unlink(tmp_path)
        logger.error(f"Transcribe Error: {e}")
        return JSONResponse(status_code=500, content={"detail": str(e)})

# --- Synthesis Request Model ---
class SynthesizeRequest(BaseModel):
    text: str
    model_repo: str = "prince-canuma/Kokoro-82M"
    voice: str = "af_heart"
    lang_code: str = "a"
    speed: float = 1.0
    speaker: Optional[str] = None

@app.post("/synthesize", dependencies=[Depends(get_api_key)])
async def synthesize_endpoint(request: SynthesizeRequest, background_tasks: BackgroundTasks):
    logger.info(f"Synthesizing using: {request.model_repo} (Len: {len(request.text)})")

    # Create a unique temp folder
    tmp_dir = tempfile.mkdtemp()
    file_prefix = os.path.join(tmp_dir, "audio")
    expected_output = file_prefix + ".wav"

    try:
        # --- PRE-PROCESSING ---
        # 1. Comma fix for Kokoro + Chinese to prevent skipped words
        text_proc = request.text
        if "Kokoro" in request.model_repo and request.lang_code == 'z':
             text_proc = "，" + text_proc

        # --- HANDLE SPEAKER REFERENCE ---
        ref_audio = None
        ref_text = None
        if request.speaker:
            speaker_wav = os.path.join("references", f"{request.speaker}.wav")
            speaker_txt = os.path.join("references", f"{request.speaker}.txt")
            if os.path.exists(speaker_wav):
                ref_audio = speaker_wav
                logger.info(f"Using speaker reference audio: {ref_audio}")
            else:
                logger.warning(f"Speaker audio not found: {speaker_wav}")
            if os.path.exists(speaker_txt):
                with open(speaker_txt, "r", encoding="utf-8") as f:
                    ref_text = f.read().strip()
                logger.info(f"Using speaker reference text: {ref_text[:50]}...")
            else:
                logger.warning(f"Speaker text not found: {speaker_txt}")

        # --- CALL API ---
        # FIX: The argument name is 'model', NOT 'model_path'. 
        # Using 'model_path' caused it to default to English Kokoro -> 1KB Silence on Chinese text.
        gen_kwargs = {
            "text": text_proc,
            "model": request.model_repo,
            "voice": request.voice,
            "lang_code": request.lang_code,
            "speed": request.speed,
            "file_prefix": file_prefix,
            "audio_format": "wav",
            "join_audio": True,
            "append_datetime": False,
            "verbose": True
        }
        if ref_audio:
            gen_kwargs["ref_audio"] = ref_audio
        if ref_text:
            gen_kwargs["ref_text"] = ref_text
        
        generate_audio(**gen_kwargs)

        # Robust file check
        final_path = None
        if os.path.exists(expected_output):
            final_path = expected_output
        elif os.path.exists(file_prefix + "_000.wav"):
            final_path = file_prefix + "_000.wav"

        if not final_path:
            logger.error(f"Files in temp: {os.listdir(tmp_dir)}")
            raise Exception("Generation finished, but no output file found.")
        
        # Check if file is essentially empty (1KB headers only)
        if os.path.getsize(final_path) < 2000:
            logger.warning("Generated file is < 2KB. Likely silence.")
            # We still return it, but log the warning.
        
        # Stream and Cleanup
        def iterfile():
            try:
                with open(final_path, mode="rb") as f:
                    yield from f
            finally:
                shutil.rmtree(tmp_dir)

        background_tasks.add_task(iterfile)
        return StreamingResponse(iterfile(), media_type="audio/wav")

    except Exception as e:
        logger.error(f"Synthesis failed: {e}")
        if os.path.exists(tmp_dir): shutil.rmtree(tmp_dir)
        return HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=APP_PORT, reload=False)