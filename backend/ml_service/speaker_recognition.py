"""
speaker_recognition.py – VocalID Speaker Recognition Engine
============================================================
Uses PyAnnote for both diarization and speaker embedding extraction.
No longer dependent on Resemblyzer (avoids C++ build issues on Windows).
"""

import os
import tempfile
import logging
from typing import List, Dict, Optional

import numpy as np

logger = logging.getLogger(__name__)


class SpeakerRecognizer:
    """
    Multi-speaker recognition using PyAnnote embeddings.

    Each enrolled student has N voice embeddings stored in MongoDB.
    During identification, the audio is segmented (diarized) and then
    compared against students using cosine similarity.
    """

    def __init__(self, hf_token: Optional[str] = None):
        self.hf_token = hf_token
        self.diarization_pipeline = None
        self.embedding_model = None

        if not hf_token:
            logger.warning("HUGGINGFACE_TOKEN not found in .env. PyAnnote models will not load.")
            return

        try:
            from pyannote.audio import Pipeline, Model, Inference
            import torch

            # 1. Load Diarization Pipeline
            self.diarization_pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                token=hf_token
            )
            
            # 2. Load Embedding Model (wespeaker - state of the art)
            # This model returns 256-d embeddings
            self.model = Model.from_pretrained(
                "pyannote/wespeaker-voxceleb-resnet34-lm",
                token=hf_token
            )
            self.embedding_inference = Inference(self.model, window="whole")

            # Move to GPU if available
            if torch.cuda.is_available():
                device = torch.device("cuda")
                self.diarization_pipeline.to(device)
                self.embedding_inference.to(device)
            
            logger.info("✅ Multi-speaker recognition engine loaded (PyAnnote + WeSpeaker)")
        except ImportError:
            logger.error("Required libraries (pyannote.audio, torch) not found. Run: pip install pyannote.audio torch")
        except Exception as e:
            logger.error(f"Failed to load Speaker Recognition models: {e}")

    # ─────────────────────────────────────────────────────────────
    #  Diarization
    # ─────────────────────────────────────────────────────────────

    def diarize(self, audio_path: str) -> List[Dict]:
        """Segment audio into speaker-wise chunks."""
        if not self.diarization_pipeline:
            return [{"start": 0.0, "end": None, "speaker": "SPEAKER_00"}]

        try:
            audio_path = self._ensure_wav(audio_path)
            diarization = self.diarization_pipeline(audio_path)
            
            segments = []
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                segments.append({
                    "start": turn.start,
                    "end": turn.end,
                    "speaker": speaker
                })
            
            # Merge adjacent segments of the same speaker
            merged = []
            if segments:
                curr = segments[0]
                for next_seg in segments[1:]:
                    if next_seg["speaker"] == curr["speaker"] and next_seg["start"] - curr["end"] < 0.5:
                        curr["end"] = next_seg["end"]
                    else:
                        merged.append(curr)
                        curr = next_seg
                merged.append(curr)
                
            return merged
        except Exception as e:
            logger.error(f"Diarization error: {e}")
            return [{"start": 0.0, "end": None, "speaker": "SPEAKER_00"}]

    # ─────────────────────────────────────────────────────────────
    #  Embedding Extraction
    # ─────────────────────────────────────────────────────────────

    def extract_embedding(self, audio_path: str) -> np.ndarray:
        """Extract a high-dimensional speaker embedding."""
        if not self.embedding_inference:
            logger.error("Embedding model not loaded.")
            return np.zeros(256)

        try:
            audio_path = self._ensure_wav(audio_path)
            # inference returns a pyannote.core.annotation.Segment-like or just the embedding
            # window="whole" ensures we get one embedding for the entire file
            emb = self.embedding_inference(audio_path)
            # Ensure it is a numpy array
            return np.array(emb).flatten()
        except Exception as e:
            logger.error(f"Embedding extraction error: {e}")
            return np.zeros(256)

    def _ensure_wav(self, audio_path: str) -> str:
        """Convert to 16kHz mono WAV if needed."""
        ext = os.path.splitext(audio_path)[1].lower()
        if ext == ".wav":
             # We still want to ensure it's 16k mono for consistency across models
             pass 
        
        try:
            import librosa
            import soundfile as sf
            y, sr = librosa.load(audio_path, sr=16000, mono=True)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            sf.write(tmp.name, y, sr)
            return tmp.name
        except Exception as e:
            logger.debug(f"Conversion skipped or failed: {e}")
            return audio_path

    # ─────────────────────────────────────────────────────────────
    #  Identification
    # ─────────────────────────────────────────────────────────────

    @staticmethod
    def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        denom = np.linalg.norm(a) * np.linalg.norm(b)
        if denom < 1e-10: return 0.0
        return float(np.dot(a, b) / denom)

    def identify_speaker(self, query_emb: np.ndarray, students: List[Dict], threshold: float = 0.70) -> Dict:
        """Find best student match for an embedding."""
        best_student = None
        best_score = -1.0

        for s in students:
            stored_embs = [np.array(e) for e in (s.get("embeddings") or [])]
            if not stored_embs: continue

            scores = [self.cosine_similarity(query_emb, emb) for emb in stored_embs]
            # More weight on top match to handle multiple sample variances
            combined = 0.8 * max(scores) + 0.2 * float(np.mean(scores))

            if combined > best_score:
                best_score = combined
                best_student = s

        if best_student and best_score >= threshold:
            return {
                "matched": True,
                "studentId": best_student["studentId"],
                "name": best_student["name"],
                "confidence": round(best_score, 4),
            }
        return {"matched": False, "confidence": round(max(best_score, 0.0), 4)}

    def identify_from_segments(self, segments: List[Dict], students: List[Dict], 
                               threshold: float = 0.70, audio_path: Optional[str] = None) -> List[Dict]:
        """Identify speakers within segments found via diarization."""
        detected = {}
        for seg in segments:
            try:
                path = audio_path
                start, end = seg.get("start"), seg.get("end")
                
                # Slicing is key for multi-speaker identification
                tmp_slice = self._slice_audio(path, start, end)
                if not tmp_slice: continue
                
                emb = self.extract_embedding(tmp_slice)
                os.unlink(tmp_slice)
                
                match = self.identify_speaker(emb, students, threshold)
                if match["matched"]:
                    sid = match["studentId"]
                    if sid not in detected or match["confidence"] > detected[sid]["confidence"]:
                        detected[sid] = match
            except Exception as e:
                logger.warning(f"Segment ID failed: {e}")

        return list(detected.values())

    def _slice_audio(self, path: str, start: float, end: Optional[float]) -> Optional[str]:
        try:
            import librosa, soundfile as sf
            # If end is None, we take till the end, but usually we need a specific chunk
            # If duration is too short (< 0.5s), identification is unreliable
            duration = (end - start) if end else None
            if duration and duration < 0.5: return None
            
            y, sr = librosa.load(path, sr=16000, mono=True, offset=start, duration=duration)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            sf.write(tmp.name, y, sr)
            return tmp.name
        except Exception:
            return None
