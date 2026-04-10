"""
train_model.py – VocalID Speaker Recognition Training
======================================================
Reads voice samples from the uploads/ directory, extracts MFCC features,
trains an SVM classifier, and saves the model as voice_model.pkl.

Voice sample naming convention expected:
    uploads/<studentId>-<anything>.<ext>
    e.g.  uploads/CS001-1714000000000.wav

Usage:
    python train_model.py [--uploads-dir PATH] [--model-out PATH]
"""

import os
import sys
import json
import argparse
import logging
import re

import numpy as np
import joblib
from sklearn.svm import SVC
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import cross_val_score

# Local utility
sys.path.insert(0, os.path.dirname(__file__))
from utils import extract_mfcc

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ── Supported audio extensions ────────────────────────────────────────────────
AUDIO_EXTENSIONS = {".wav", ".webm", ".ogg", ".mp3", ".mp4", ".m4a"}


def parse_student_id(filename: str) -> str | None:
    """
    Derive the student ID from a voice-sample filename.

    Supported formats:
      • CS001-<suffix>.<ext>   → CS001     (dash-delimited prefix)
      • voice-<suffix>.<ext>   → skipped   (generic name, no student ID)

    The student ID stored in MongoDB is always uppercase.
    """
    base = os.path.splitext(os.path.basename(filename))[0]  # strip extension

    # Skip generic "voice-<timestamp>" files that have no student ID prefix
    if base.startswith("voice-"):
        return None

    # Take everything before the first dash/underscore as the student ID
    match = re.match(r"^([A-Za-z0-9]+)[-_]", base)
    if match:
        return match.group(1).upper()

    # If no separator found treat the whole base as ID
    return base.upper()


def collect_samples(uploads_dir: str):
    """
    Walk the uploads directory (top-level only) and collect (feature_vector, student_id) pairs.
    Skips the 'temp/' subdirectory and any generic 'voice-' prefixed files.

    Returns
    -------
    tuple[list[np.ndarray], list[str]]
        features, labels
    """
    features, labels = [], []

    if not os.path.isdir(uploads_dir):
        logger.error(f"Uploads directory not found: {uploads_dir}")
        return features, labels

    # Only scan top-level files, not subdirectories (e.g. not uploads/temp/)
    for fname in os.listdir(uploads_dir):
        full_path = os.path.join(uploads_dir, fname)
        if os.path.isdir(full_path):
            continue  # skip subdirectories (temp/, etc.)

        ext = os.path.splitext(fname)[1].lower()
        if ext not in AUDIO_EXTENSIONS:
            continue

        student_id = parse_student_id(fname)
        if not student_id:
            logger.warning(f"Skipping '{fname}' – cannot determine student ID (generic filename).")
            continue

        try:
            mfcc_vec = extract_mfcc(full_path)
            features.append(mfcc_vec)
            labels.append(student_id)
            logger.info(f"  ✓ Extracted features from '{fname}' → label='{student_id}'")
        except Exception as exc:
            logger.warning(f"  ✗ Skipping '{fname}': {exc}")

    return features, labels


def train(uploads_dir: str, model_out: str) -> None:
    """
    Main training routine.

    Steps:
      1. Collect MFCC feature vectors from the uploads directory.
      2. Encode string labels to integers via LabelEncoder.
      3. Build an SVM Pipeline (StandardScaler → SVC).
      4. Optionally run 3-fold cross-validation if enough samples exist.
      5. Fit the final model on all data.
      6. Persist the pipeline + label encoder with joblib.
    """
    logger.info("═" * 60)
    logger.info("VocalID – SVM Speaker Recognition Training")
    logger.info(f"Uploads directory : {uploads_dir}")
    logger.info(f"Model output path : {model_out}")
    logger.info("═" * 60)

    # ── 1. Collect samples ────────────────────────────────────────────────────
    logger.info("Scanning uploads directory …")
    features, labels = collect_samples(uploads_dir)

    if len(features) < 2:
        logger.error(
            "Not enough samples to train. "
            "Need at least 2 labelled audio files in the uploads directory.\n"
            "Ensure filenames follow the pattern: <STUDENT_ID>-<suffix>.<ext>\n"
            "Example: CS001-sample.wav"
        )
        sys.exit(1)

    X = np.array(features)           # (n_samples, N_MFCC)
    y_raw = np.array(labels)         # string labels

    unique_classes = np.unique(y_raw)
    logger.info(f"Found {len(X)} sample(s) for {len(unique_classes)} student(s): {list(unique_classes)}")

    # ── 2. Encode labels ──────────────────────────────────────────────────────
    le = LabelEncoder()
    y = le.fit_transform(y_raw)

    # ── 3. Build SVM pipeline ─────────────────────────────────────────────────
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("svm", SVC(
            kernel="rbf",
            C=10,
            gamma="scale",
            probability=True,    # needed for confidence scores
            class_weight="balanced"
        ))
    ])

    # ── 4. Cross-validation (only when we have ≥ 2 samples per class) ─────────
    min_class_count = min(np.bincount(y))
    if min_class_count >= 2 and len(unique_classes) >= 2:
        n_splits = min(3, min_class_count)
        cv_scores = cross_val_score(pipeline, X, y, cv=n_splits, scoring="accuracy")
        logger.info(f"Cross-validation accuracy ({n_splits}-fold): "
                    f"{cv_scores.mean():.2%} ± {cv_scores.std():.2%}")
    else:
        logger.warning("Not enough samples per class for cross-validation. Skipping.")

    # ── 5. Fit on all data ────────────────────────────────────────────────────
    pipeline.fit(X, y)
    logger.info("Model training complete.")

    # ── 6. Save artefacts ─────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(model_out) or ".", exist_ok=True)

    model_bundle = {
        "pipeline": pipeline,
        "label_encoder": le,
        "classes": list(le.classes_),
        "n_features": X.shape[1],
        "n_samples": len(X),
        "n_classes": len(unique_classes)
    }

    joblib.dump(model_bundle, model_out)
    logger.info(f"✅  Model saved to '{model_out}'")
    logger.info(f"    Classes : {list(le.classes_)}")
    logger.info(f"    Samples : {len(X)}")


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train VocalID SVM speaker recognition model.")
    parser.add_argument(
        "--uploads-dir",
        default=os.path.join(os.path.dirname(__file__), "..", "uploads"),
        help="Path to the uploads directory containing labelled voice samples."
    )
    parser.add_argument(
        "--model-out",
        default=os.path.join(os.path.dirname(__file__), "voice_model.pkl"),
        help="Output path for the trained model pickle file."
    )
    args = parser.parse_args()

    train(
        uploads_dir=os.path.abspath(args.uploads_dir),
        model_out=os.path.abspath(args.model_out)
    )
