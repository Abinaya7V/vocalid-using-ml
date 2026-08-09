import os
import logging
from typing import List
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from dotenv import load_dotenv

from speaker_recognition import SpeakerRecognizer

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

app = FastAPI(title="VocalID ML Service", version="2.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# MongoDB Connection
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/vocalid")
HF_TOKEN = os.getenv("HUGGINGFACE_TOKEN")

client = MongoClient(MONGO_URI)
db = client.get_database()
students_col = db.students

# Initialize Recognizer
recognizer = SpeakerRecognizer(hf_token=HF_TOKEN)

@app.get("/health")
def health():
    return {"status": "ok", "message": "VocalID Multi-Speaker Recognition Service is running"}

@app.post("/enroll")
async def enroll_student(
    student_id: str = Form(...),
    file: UploadFile = File(...)
):
    """
    Extract speaker embedding from audio and store in MongoDB.
    """
    try:
        # Save temp file
        temp_path = f"temp_enroll_{student_id}_{file.filename}"
        with open(temp_path, "wb") as f:
            f.write(await file.read())
        
        # Extract embedding
        embedding = recognizer.extract_embedding(temp_path)
        
        # Clean up
        os.remove(temp_path)
        
        # Store in MongoDB (append to embeddings list)
        # We store as list of floats for JSON compatibility
        embedding_list = embedding.tolist()
        
        result = students_col.update_one(
            {"studentId": student_id.upper()},
            {"$push": {"embeddings": embedding_list}, "$set": {"isVoiceRegistered": True}}
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Student not found")
            
        return {"success": True, "message": f"Embedding enrolled for student {student_id}"}
        
    except Exception as e:
        logger.error(f"Enrollment error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/process-audio")
async def process_audio(
    file: UploadFile = File(...),
    threshold: float = Form(0.75)
):
    """
    Diarize classroom audio and identify all speakers.
    """
    try:
        # Save temp file
        temp_path = f"temp_process_{file.filename}"
        with open(temp_path, "wb") as f:
            f.write(await file.read())
        
        # 1. Diarization
        segments = recognizer.diarize(temp_path)
        logger.info(f"Diarization found {len(segments)} segments")
        
        # 2. Fetch all enrolled students with embeddings
        # We only need students who have embeddings
        students_cursor = students_col.find({"isVoiceRegistered": True})
        enrolled_students = []
        for s in students_cursor:
            enrolled_students.append({
                "studentId": s["studentId"],
                "name": s["name"],
                "embeddings": s.get("embeddings", [])
            })
            
        if not enrolled_students:
            return {"detected_students": [], "message": "No students enrolled for voice recognition."}
            
        # 3. Identification
        # Use simple mapping for segments to pass to identify_from_segments
        # identify_from_segments expects segments to have 'start' and 'end'
        detected = recognizer.identify_from_segments(
            segments=segments,
            students=enrolled_students,
            threshold=threshold,
            audio_path=temp_path
        )
        
        # Clean up
        os.remove(temp_path)
        
        # Filter and format output
        result = []
        for item in detected:
            if item["matched"]:
                result.append({
                    "name": item["name"],
                    "studentId": item["studentId"],
                    "confidence": item["confidence"]
                })
                
        return {"detected_students": result}
        
    except Exception as e:
        logger.error(f"Processing error: {e}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
