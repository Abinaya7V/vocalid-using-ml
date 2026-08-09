import sys
import os
import json
from face_utils import detect_and_extract_face, compute_similarity, similarity_to_confidence, COSINE_THRESHOLD

def main():
    if len(sys.argv) < 3:
        result = {
            "success": False,
            "face_detected": False,
            "matched": False,
            "similarity": 0.0,
            "confidence": 0.0,
            "error": "Usage: python face_predict.py <live_image_path> <registered_embeddings_json_path_or_string>"
        }
        print(json.dumps(result))
        sys.exit(1)

    live_image_path = sys.argv[1]
    embeddings_arg = sys.argv[2]

    # Parse registered embeddings
    registered_embeddings = []
    try:
        if os.path.exists(embeddings_arg):
            with open(embeddings_arg, 'r') as f:
                registered_embeddings = json.load(f)
        else:
            registered_embeddings = json.loads(embeddings_arg)
    except Exception as err:
        result = {
            "success": False,
            "face_detected": False,
            "matched": False,
            "similarity": 0.0,
            "confidence": 0.0,
            "error": f"Invalid registered embeddings format: {err}"
        }
        print(json.dumps(result))
        sys.exit(1)

    if not registered_embeddings or len(registered_embeddings) == 0:
        result = {
            "success": False,
            "face_detected": False,
            "matched": False,
            "similarity": 0.0,
            "confidence": 0.0,
            "error": "No registered face embeddings found for student."
        }
        print(json.dumps(result))
        sys.exit(1)

    # Detect face in live image
    if not os.path.exists(live_image_path):
        result = {
            "success": False,
            "face_detected": False,
            "matched": False,
            "similarity": 0.0,
            "confidence": 0.0,
            "error": f"Live image file not found: {live_image_path}"
        }
        print(json.dumps(result))
        sys.exit(1)

    ok, live_embedding, face_count, msg = detect_and_extract_face(live_image_path)
    if not ok:
        result = {
            "success": False,
            "face_detected": False,
            "matched": False,
            "similarity": 0.0,
            "confidence": 0.0,
            "error": msg
        }
        print(json.dumps(result))
        sys.exit(0)

    # Compute similarity against registered embeddings
    max_sim = -1.0
    for reg_emb in registered_embeddings:
        sim = compute_similarity(live_embedding, reg_emb)
        if sim > max_sim:
            max_sim = sim

    matched = bool(max_sim >= COSINE_THRESHOLD)
    confidence = similarity_to_confidence(max_sim, COSINE_THRESHOLD)

    result = {
        "success": True,
        "face_detected": True,
        "matched": matched,
        "similarity": round(float(max_sim), 4),
        "confidence": confidence,
        "threshold": COSINE_THRESHOLD,
        "message": "Face verification successful." if matched else "Face verification failed. Biometric match score below threshold."
    }
    print(json.dumps(result))

if __name__ == "__main__":
    main()
