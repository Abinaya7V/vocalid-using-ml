import os
import sys
import urllib.request
import cv2
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "models")

YUNET_MODEL_FILENAME = "face_detection_yunet_2023mar.onnx"
SFACE_MODEL_FILENAME = "face_recognition_sface_2021dec.onnx"

YUNET_MODEL_PATH = os.path.join(MODELS_DIR, YUNET_MODEL_FILENAME)
SFACE_MODEL_PATH = os.path.join(MODELS_DIR, SFACE_MODEL_FILENAME)

YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
SFACE_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"

COSINE_THRESHOLD = 0.363  # Official recommended threshold for SFace Cosine similarity

def ensure_models_exist():
    """Ensure ONNX model files are present in backend/ml/models/"""
    if not os.path.exists(MODELS_DIR):
        os.makedirs(MODELS_DIR, exist_ok=True)
    
    if not os.path.exists(YUNET_MODEL_PATH):
        sys.stderr.write(f"[FaceML] Downloading YuNet face detector model to {YUNET_MODEL_PATH}...\n")
        try:
            urllib.request.urlretrieve(YUNET_URL, YUNET_MODEL_PATH)
            sys.stderr.write("[FaceML] YuNet model downloaded successfully.\n")
        except Exception as e:
            sys.stderr.write(f"[FaceML] Failed to download YuNet model: {e}\n")
            raise

    if not os.path.exists(SFACE_MODEL_PATH):
        sys.stderr.write(f"[FaceML] Downloading SFace face recognizer model to {SFACE_MODEL_PATH}...\n")
        try:
            urllib.request.urlretrieve(SFACE_URL, SFACE_MODEL_PATH)
            sys.stderr.write("[FaceML] SFace model downloaded successfully.\n")
        except Exception as e:
            sys.stderr.write(f"[FaceML] Failed to download SFace model: {e}\n")
            raise

def load_image(image_input):
    """Load image from path string or return numpy array if already image mat"""
    if isinstance(image_input, str):
        if not os.path.exists(image_input):
            raise FileNotFoundError(f"Image path not found: {image_input}")
        img = cv2.imread(image_input)
        if img is None:
            raise ValueError(f"Failed to decode image from path: {image_input}")
        return img
    elif isinstance(image_input, np.ndarray):
        return image_input
    else:
        raise TypeError("image_input must be a file path string or numpy array")

def create_detector(img_width, img_height, score_threshold=0.6, nms_threshold=0.3, top_k=5000):
    """Create OpenCV YuNet face detector instance"""
    ensure_models_exist()
    return cv2.FaceDetectorYN.create(
        model=YUNET_MODEL_PATH,
        config="",
        input_size=(img_width, img_height),
        score_threshold=score_threshold,
        nms_threshold=nms_threshold,
        top_k=top_k
    )

def create_recognizer():
    """Create OpenCV SFace face recognizer instance"""
    ensure_models_exist()
    return cv2.FaceRecognizerSF.create(
        model=SFACE_MODEL_PATH,
        config=""
    )

def detect_and_extract_face(image_input):
    """
    Detect face in image and extract aligned feature vector using SFace.
    Returns: (success_bool, embedding_array_or_None, face_count, message)
    """
    try:
        img = load_image(image_input)
        h, w, _ = img.shape
        if h == 0 or w == 0:
            return False, None, 0, "Invalid image dimensions."

        detector = create_detector(w, h)
        _, faces = detector.detect(img)

        if faces is None or len(faces) == 0:
            return False, None, 0, "No face detected in image. Please ensure your face is clearly visible."

        if len(faces) > 1:
            return False, None, len(faces), f"Multiple faces detected ({len(faces)}). Only one face should be visible."

        face = faces[0]
        recognizer = create_recognizer()
        aligned_face = recognizer.alignCrop(img, face)
        embedding = recognizer.feature(aligned_face)

        # Flatten 1D array
        embedding_flat = embedding.flatten().astype(float)
        return True, embedding_flat, 1, "Face detected and feature vector extracted."

    except Exception as e:
        sys.stderr.write(f"[FaceML Error] {e}\n")
        return False, None, 0, str(e)

def compute_similarity(emb1, emb2):
    """
    Compute Cosine similarity between two feature vectors.
    SFace cosine similarity threshold is ~0.363.
    """
    vec1 = np.array(emb1, dtype=np.float32).reshape(1, -1)
    vec2 = np.array(emb2, dtype=np.float32).reshape(1, -1)
    
    # Normalize vectors
    norm1 = np.linalg.norm(vec1)
    norm2 = np.linalg.norm(vec2)
    
    if norm1 == 0 or norm2 == 0:
        return 0.0
    
    sim = np.dot(vec1, vec2.T)[0][0] / (norm1 * norm2)
    return float(sim)

def similarity_to_confidence(similarity, threshold=COSINE_THRESHOLD):
    """
    Convert cosine similarity to normalized confidence percentage (0-100%).
    """
    if similarity < 0:
        return 0.0
    if similarity >= threshold:
        # Scale similarity from threshold..1.0 to 50..100%
        conf = 50.0 + ((similarity - threshold) / (1.0 - threshold)) * 50.0
    else:
        # Scale similarity from 0..threshold to 0..50%
        conf = (similarity / threshold) * 50.0
    
    return round(min(100.0, max(0.0, float(conf))), 2)

if __name__ == "__main__":
    sys.stderr.write("Checking face_utils environment...\n")
    try:
        ensure_models_exist()
        sys.stderr.write("Models verified successfully.\n")
        print("{\"status\": \"ok\", \"models_exist\": true}")
    except Exception as err:
        sys.stderr.write(f"Verification error: {err}\n")
        print("{\"status\": \"error\", \"models_exist\": false}")
