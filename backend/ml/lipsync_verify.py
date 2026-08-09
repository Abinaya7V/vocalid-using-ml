import sys
import os
import json
from lipsync_utils import verify_lipsync_and_liveness

def main():
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

    liveness_ok, score, confidence, msg = verify_lipsync_and_liveness(video_path, audio_path)

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
