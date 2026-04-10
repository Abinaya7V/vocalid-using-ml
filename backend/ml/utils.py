"""
utils.py – VocalID ML Utilities
================================
Shared helper functions for MFCC feature extraction and audio loading.
Used by both train_model.py and predict_speaker.py.
"""

import numpy as np
import librosa
import logging

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
N_MFCC = 40          # Number of MFCC coefficients to extract
SAMPLE_RATE = 22050  # Target sample rate in Hz
DURATION = None      # Load full audio (set a float value in seconds to truncate)


def load_audio(file_path: str):
    """
    Load an audio file and convert it to mono.

    Parameters
    ----------
    file_path : str
        Absolute or relative path to the audio file.

    Returns
    -------
    tuple[np.ndarray, int]
        (waveform, sample_rate) – mono float32 waveform and sample rate.

    Raises
    ------
    FileNotFoundError
        If the file does not exist.
    RuntimeError
        If librosa cannot load the file.
    """
    import os
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    try:
        waveform, sr = librosa.load(
            file_path,
            sr=SAMPLE_RATE,          # resample to target SR
            mono=True,               # force single channel
            duration=DURATION        # None = full file
        )
        logger.debug(f"Loaded '{file_path}' | SR={sr} | Duration={len(waveform)/sr:.2f}s")
        return waveform, sr
    except Exception as exc:
        raise RuntimeError(f"Failed to load audio file '{file_path}': {exc}") from exc


def extract_mfcc(file_path: str) -> np.ndarray:
    """
    Extract MFCC features from an audio file.

    Process:
      1. Load the audio file and convert to mono.
      2. Extract N_MFCC MFCC coefficients using librosa.
      3. Compute the mean across time frames to produce a fixed-length vector.

    Parameters
    ----------
    file_path : str
        Path to the audio file.

    Returns
    -------
    np.ndarray
        1-D feature vector of shape (N_MFCC,).

    Raises
    ------
    FileNotFoundError, RuntimeError
        Propagated from load_audio().
    """
    waveform, sr = load_audio(file_path)

    # librosa.feature.mfcc returns shape (N_MFCC, T) where T = number of frames
    mfccs = librosa.feature.mfcc(y=waveform, sr=sr, n_mfcc=N_MFCC)

    # Collapse time dimension → fixed-length feature vector
    mfcc_mean = np.mean(mfccs, axis=1)  # shape: (N_MFCC,)

    logger.debug(f"Extracted MFCC feature vector of shape {mfcc_mean.shape}")
    return mfcc_mean
