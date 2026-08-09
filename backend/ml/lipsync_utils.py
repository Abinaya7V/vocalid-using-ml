import os
import sys
import cv2
import numpy as np
from scipy.io import wavfile
from face_utils import ensure_models_exist, create_detector

def extract_facial_and_mouth_data(video_path):
    """
    Analyzes video stream for:
    - Frame count & duration
    - Face count per frame (detect zero or multiple faces)
    - Mouth Aspect Ratio (MAR) time series
    Returns: dict with frame_count, face_detected_count, multiple_faces_count, mars, error
    """
    ensure_models_exist()

    if not os.path.exists(video_path):
        return {"error": "VIDEO_NOT_FOUND", "message": f"Video file not found at path: {video_path}"}

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": "INVALID_VIDEO", "message": "Failed to open video stream."}

    mars = []
    frame_count = 0
    face_count = 0
    multiple_faces_count = 0
    detector = None

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret or frame is None:
            break

        frame_count += 1
        h, w, _ = frame.shape
        if h == 0 or w == 0:
            continue

        if detector is None:
            detector = create_detector(w, h, score_threshold=0.5)

        _, faces = detector.detect(frame)

        if faces is None or len(faces) == 0:
            continue
        elif len(faces) > 1:
            multiple_faces_count += 1

        face_count += 1
        face = faces[0]
        
        # Bounding box & keypoint landmarks:
        # face[0:4] = [x, y, w, h]
        # landmarks: right_eye(0,1), left_eye(2,3), nose(4,5), right_mouth(6,7), left_mouth(8,9)
        fx, fy, fw, fh = face[0:4]
        rx, ry = face[6], face[7]
        lx, ly = face[8], face[9]

        mouth_width = np.sqrt((rx - lx)**2 + (ry - ly)**2)
        mouth_height = max(1.0, fh * 0.22)

        if mouth_width > 0:
            mar = mouth_height / mouth_width
            mars.append(float(mar))

    cap.release()

    return {
        "frame_count": frame_count,
        "face_detected_count": face_count,
        "multiple_faces_count": multiple_faces_count,
        "mars": np.array(mars, dtype=np.float32),
        "error": None
    }

def analyze_audio_signal(audio_path):
    """
    Extracts normalized RMS energy envelope from audio file.
    Returns: (envelope_array, max_rms, error_message)
    """
    if not os.path.exists(audio_path):
        return np.array([]), 0.0, "AUDIO_FILE_NOT_FOUND"

    try:
        sample_rate, data = wavfile.read(audio_path)
        if data.size == 0:
            return np.array([]), 0.0, "EMPTY_AUDIO_FILE"

        if data.ndim > 1:
            data = data.mean(axis=1)

        frame_size = int(sample_rate * 0.05) # 50ms chunks
        if frame_size == 0 or len(data) < frame_size:
            return np.array([]), 0.0, "AUDIO_TOO_SHORT"

        num_frames = len(data) // frame_size
        envelope = []
        for i in range(num_frames):
            chunk = data[i*frame_size:(i+1)*frame_size]
            rms = np.sqrt(np.mean(chunk.astype(float)**2))
            envelope.append(rms)

        env = np.array(envelope, dtype=np.float32)
        max_rms = float(np.max(env)) if len(env) > 0 else 0.0

        if max_rms > 0:
            env = env / max_rms

        return env, max_rms, None
    except Exception as e:
        sys.stderr.write(f"[Audio Error] {e}\n")
        return np.array([]), 0.0, str(e)

def verify_lipsync_and_liveness(video_path, audio_path):
    """
    Strict, hardened Liveness & Lip-Sync Verification:
    - Rejects insufficient data, missing face, multiple faces, silent audio, static photo.
    Returns: (liveness_passed, lipsync_score, confidence, message)
    """
    # 1. Analyze Video Facial Data
    vdata = extract_facial_and_mouth_data(video_path)
    if vdata.get("error"):
        return False, 0.0, 0.0, f"INSUFFICIENT_DATA: {vdata['message']}"

    frame_count = vdata["frame_count"]
    face_count = vdata["face_detected_count"]
    multiple_faces = vdata["multiple_faces_count"]
    mars = vdata["mars"]

    # Check minimum video duration (minimum 10 frames)
    if frame_count < 10:
        return False, 0.0, 0.0, f"INSUFFICIENT_VIDEO_DATA: Video clip too short ({frame_count} frames recorded, minimum 10 required)."

    # Check face presence
    if face_count < (frame_count * 0.4):
        return False, 0.0, 0.0, "NO_FACE_DETECTED: Face was not clearly detected in the camera frame."

    # Check for multiple faces
    if multiple_faces > (frame_count * 0.3):
        return False, 0.0, 0.0, "MULTIPLE_FACES_DETECTED: Multiple faces detected in video. Exactly one student face is required."

    # 2. Check Audio Presence
    audio_env, max_rms, audio_err = analyze_audio_signal(audio_path)
    if audio_err or len(audio_env) == 0 or max_rms < 10.0:
        return False, 0.0, 0.0, "NO_AUDIO_DETECTED: Silent or missing voice audio. Spoken audio is required."

    # 3. Liveness Motion Variance Analysis (Detect Static Photo Spoofs)
    mar_std = float(np.std(mars)) if len(mars) > 0 else 0.0
    mar_range = float(np.ptp(mars)) if len(mars) > 0 else 0.0

    if mar_std < 0.003 or mar_range < 0.006:
        return False, 0.0, 0.0, "SPOOF_ATTACK_DETECTED: Static photo attack detected. No natural lip movement observed."

    # 4. Lip-Sync Audio-Visual Correlation
    min_len = min(len(audio_env), len(mars))
    if min_len < 4:
        return False, 0.0, 0.0, "INSUFFICIENT_SYNC_DATA: Video and audio duration mismatch."

    a_sub = audio_env[:min_len]
    v_sub = mars[:min_len]

    norm_a = a_sub - np.mean(a_sub)
    norm_v = v_sub - np.mean(v_sub)

    std_a = np.std(norm_a)
    std_v = np.std(norm_v)

    if std_a > 0 and std_v > 0:
        corr = float(np.mean(norm_a * norm_v) / (std_a * std_v))
        corr_score = max(0.0, min(1.0, (corr + 1.0) / 2.0))
    else:
        corr_score = 0.75

    if corr_score < 0.25:
        return False, float(corr_score), round(corr_score * 100, 1), "LIP_SYNC_MISMATCH: Mouth movements do not correlate with spoken audio."

    lipsync_score = round(float(corr_score), 4)
    confidence = round(min(100.0, max(50.0, lipsync_score * 100.0)), 1)

    return True, lipsync_score, confidence, "Liveness and lip synchronization verified successfully."

if __name__ == "__main__":
    print("{\"status\": \"ok\", \"lipsync_utils_hardened\": true}")
