import sys
import os
import json

try:
    from lipsync_utils import verify_lipsync_and_liveness
    IMPORT_ERROR = None
except Exception as _e:
    verify_lipsync_and_liveness = None
    IMPORT_ERROR = str(_e)

def main():
    if IMPORT_ERROR is not None:
        result = {
            "success": False,
            "liveness_passed": False,
            "lipsync_score": 0.0,
            "liveness_confidence": 0.0,
            "audio_sync_matched": False,
            "error": f"ML_DEPENDENCY_ERROR: Could not load face/lip-sync libraries ({IMPORT_ERROR}). "
                     f"Check that opencv-contrib-python and librosa are installed (pip install -r requirements.txt)."
        }
        print(json.dumps(result))
        sys.exit(0)

    if len(sys.argv) < 3:
        result = {
            "success": False,
            "liveness_passed": False,
            "lipsync_score": 0.0,
            "liveness_confidence": 0.0,
            "audio_sync_matched": False,
            "error": "Usage: python lipsync_verify.py <video_path> <audio_path>"
        }
        print(json.dumps(result))
        sys.exit(1)

    video_path = sys.argv[1]
    audio_path = sys.argv[2]

    if not os.path.exists(video_path):
        result = {
            "success": False,
            "liveness_passed": False,
            "lipsync_score": 0.0,
            "liveness_confidence": 0.0,
            "audio_sync_matched": False,
            "error": f"Video clip file not found: {video_path}"
        }
        print(json.dumps(result))
        sys.exit(1)

    try:
        liveness_ok, score, confidence, msg = verify_lipsync_and_liveness(video_path, audio_path)
    except Exception as e:
        result = {
            "success": False,
            "liveness_passed": False,
            "lipsync_score": 0.0,
            "liveness_confidence": 0.0,
            "audio_sync_matched": False,
            "error": f"UNEXPECTED_ERROR: {e}"
        }
        print(json.dumps(result))
        sys.exit(0)

    if liveness_ok:
        result = {
            "success": True,
            "liveness_passed": True,
            "lipsync_score": score,
            "liveness_confidence": confidence,
            "audio_sync_matched": True,
            "message": msg
        }
    else:
        result = {
            "success": False,
            "liveness_passed": False,
            "lipsync_score": 0.0,
            "liveness_confidence": 0.0,
            "audio_sync_matched": False,
            "error": msg
        }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
