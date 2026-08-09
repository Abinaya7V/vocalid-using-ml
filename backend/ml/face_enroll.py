import sys
import os
import json
from face_utils import detect_and_extract_face

def main():
    if len(sys.argv) < 3:
        result = {
            "success": False,
            "student_id": sys.argv[1] if len(sys.argv) > 1 else "unknown",
            "samples_processed": 0,
            "embeddings": [],
            "error": "Usage: python face_enroll.py <student_id> <sample_path_1> [<sample_path_2> ...]"
        }
        print(json.dumps(result))
        sys.exit(1)

    student_id = sys.argv[1]
    sample_paths = sys.argv[2:]

    valid_embeddings = []
    processed_count = 0

    for idx, path in enumerate(sample_paths, 1):
        if not os.path.exists(path):
            result = {
                "success": False,
                "student_id": student_id,
                "samples_processed": processed_count,
                "embeddings": [],
                "error": f"Sample file not found: {path}"
            }
            print(json.dumps(result))
            sys.exit(1)

        ok, embedding, count, msg = detect_and_extract_face(path)
        if not ok:
            result = {
                "success": False,
                "student_id": student_id,
                "samples_processed": processed_count,
                "embeddings": [],
                "error": f"Sample {idx} error: {msg}"
            }
            print(json.dumps(result))
            sys.exit(1)

        valid_embeddings.append(embedding.tolist())
        processed_count += 1

    result = {
        "success": True,
        "student_id": student_id,
        "samples_processed": processed_count,
        "embeddings": valid_embeddings,
        "message": f"Successfully processed {processed_count} face sample(s)."
    }
    print(json.dumps(result))

if __name__ == "__main__":
    main()
