"""
predict_speaker.py – VocalID Speaker Prediction
===============================================
Loads the trained SVM model, extracts MFCC features from a new voice
sample, and prints a JSON result to stdout for the Node.js backend to consume.

Output format (stdout):
    {"predicted_student": "CS001", "confidence": 0.92}

On error, exits with code 1 and prints:
    {"error": "<message>"}

Usage:
    python predict_speaker.py <audio_file_path> [--model-path PATH]
"""

import os
import sys
import json
import argparse
import logging

import numpy as np
import joblib

# Local utility
sys.path.insert(0, os.path.dirname(__file__))
from utils import extract_mfcc

# ── Logging goes to stderr so stdout stays clean JSON ─────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr
)
logger = logging.getLogger(__name__)

# Default model path (relative to this script's directory)
DEFAULT_MODEL_PATH = os.path.join(os.path.dirname(__file__), "voice_model.pkl")

# Minimum confidence threshold (0–1). Predictions below this are flagged.
CONFIDENCE_THRESHOLD = 0.50


def load_model(model_path: str) -> dict:
    """
    Load the model bundle saved by train_model.py.

    Returns
    -------
    dict with keys: pipeline, label_encoder, classes, n_features, …
    """
    if not os.path.isfile(model_path):
        raise FileNotFoundError(
            f"Model file not found: '{model_path}'. "
            "Run train_model.py first to generate voice_model.pkl."
        )
    bundle = joblib.load(model_path)
    logger.info(f"Model loaded from '{model_path}' | classes={bundle['classes']}")
    return bundle


def predict(audio_path: str, model_path: str) -> dict:
    """
    Predict the speaker for a given audio file.

    Parameters
    ----------
    audio_path : str
        Path to the voice sample to classify.
    model_path : str
        Path to the trained model pickle.

    Returns
    -------
    dict
        {
          "predicted_student": "CS001",
          "confidence": 0.92,
          "all_scores": {"CS001": 0.92, "CS002": 0.08},
          "low_confidence": False
        }
    """
    # ── Load artefacts ────────────────────────────────────────────────────────
    bundle = load_model(model_path)
    pipeline = bundle["pipeline"]
    le = bundle["label_encoder"]

    # ── Extract features ──────────────────────────────────────────────────────
    logger.info(f"Extracting MFCC features from '{audio_path}' …")
    mfcc_vec = extract_mfcc(audio_path)  # shape: (N_MFCC,)

    # Validate feature dimensionality
    expected_features = bundle.get("n_features")
    if expected_features and mfcc_vec.shape[0] != expected_features:
        raise ValueError(
            f"Feature dimension mismatch: got {mfcc_vec.shape[0]}, "
            f"expected {expected_features}. Re-train the model."
        )

    X = mfcc_vec.reshape(1, -1)  # shape: (1, N_MFCC)

    # ── Predict ───────────────────────────────────────────────────────────────
    predicted_index = pipeline.predict(X)[0]           # int class index
    probabilities = pipeline.predict_proba(X)[0]       # probability per class

    predicted_label = le.inverse_transform([predicted_index])[0]  # e.g. "CS001"
    confidence = float(probabilities[predicted_index])

    # Build per-class score map
    all_scores = {label: float(prob) for label, prob in zip(le.classes_, probabilities)}

    logger.info(
        f"Prediction: {predicted_label} | "
        f"Confidence: {confidence:.2%} | "
        f"Low-confidence flag: {confidence < CONFIDENCE_THRESHOLD}"
    )

    return {
        "predicted_student": predicted_label,
        "confidence": round(confidence, 4),
        "all_scores": all_scores,
        "low_confidence": confidence < CONFIDENCE_THRESHOLD
    }


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Predict speaker from a voice sample.")
    parser.add_argument("audio_file", help="Path to the audio file to classify.")
    parser.add_argument(
        "--model-path",
        default=DEFAULT_MODEL_PATH,
        help="Path to the trained voice_model.pkl file."
    )
    args = parser.parse_args()

    try:
        result = predict(
            audio_path=os.path.abspath(args.audio_file),
            model_path=os.path.abspath(args.model_path)
        )
        # Print clean JSON to stdout – this is what Node.js reads
        print(json.dumps(result))
        sys.exit(0)

    except FileNotFoundError as exc:
        print(json.dumps({"error": str(exc)}))
        logger.error(str(exc))
        sys.exit(1)

    except ValueError as exc:
        print(json.dumps({"error": str(exc)}))
        logger.error(str(exc))
        sys.exit(1)

    except Exception as exc:
        print(json.dumps({"error": f"Unexpected error: {exc}"}))
        logger.exception("Unexpected error during prediction.")
        sys.exit(1)
