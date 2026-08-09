# Day 1: Face Recognition Module Implementation Plan

Integrating a standalone, lightweight, and robust **Face Recognition Module** into the existing **VocalID** system using OpenCV, YuNet face detection, and SFace face embedding matching.

---

## 1. Architectural Strategy & Component Design

### Technical Stack
- **Face Detection**: OpenCV `cv2.FaceDetectorYN` (YuNet model) — lightweight ONNX model (~230 KB), fast CPU execution on Windows.
- **Face Recognition / Embedding**: OpenCV `cv2.FaceRecognizerSF` (SFace model) — 128-dimensional embedding vector (~1.2 MB ONNX model).
- **Python Integration**: Node `child_process.spawn()` executing `face_enroll.py` and `face_predict.py` with standard JSON stdout IPC.
- **Database Storage**: `faceEmbeddings: [[Number]]` stored in MongoDB `Student` document, along with `isFaceRegistered` and `faceRegisteredAt`.
- **Frontend Camera**: WebRTC `navigator.mediaDevices.getUserMedia` with canvas frame snapshot capture.

---

## 2. Proposed Changes

### Component 1: Machine Learning Service (`backend/ml/`)

#### [NEW] [face_utils.py](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/backend/ml/face_utils.py)
- Utility functions for face detection using YuNet and embedding extraction using SFace.
- Auto-downloads `face_detection_yunet_2023mar.onnx` and `face_recognition_sface_2021dec.onnx` to `backend/ml/models/` if missing.
- Input validation: returns explicit errors if no face is detected or if multiple faces are present.
- Similarity computation: Cosine similarity calculation between test feature vectors and registered embedding samples.

#### [NEW] [face_enroll.py](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/backend/ml/face_enroll.py)
- CLI script called by Node spawn during student face enrollment.
- Accepts student ID and array of sample image file paths.
- Extracts embeddings for each sample, validates quality, and prints JSON stdout containing `success`, `student_id`, `samples_processed`, and `embeddings`.

#### [NEW] [face_predict.py](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/backend/ml/face_predict.py)
- CLI script called by Node spawn during face verification.
- Accepts test image path and registered embeddings file/data path.
- Extracts test embedding, compares against registered embeddings using Cosine similarity, determines match against threshold (`0.363`), and calculates normalized confidence percentage.
- Outputs clean JSON to stdout.

#### [NEW] [requirements.txt](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/backend/ml/requirements.txt)
- Specifies Python requirements (`opencv-python>=4.8.0`, `numpy>=1.24.0`).

---

### Component 2: Backend Express Server (`backend/server.js`)

#### [MODIFY] [server.js](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/backend/server.js)
- Extend `studentSchema` with `isFaceRegistered` (Boolean), `faceRegisteredAt` (Date), `faceEmbeddings` (`[[Number]]`), and `faceSamplePaths` (`[String]`).
- Add Multer `uploadFace` configuration targeting `uploads/face/` for JPG/PNG/WebP file types up to 10MB.
- Add route `POST /api/upload-face` (JWT protected): processes face enrollment images via `face_enroll.py` and stores embeddings in MongoDB.
- Add route `POST /api/verify-face` (JWT protected): processes verification image via `face_predict.py` against `req.student.faceEmbeddings` and returns match status and confidence score.
- Update `/api/register`, `/api/login`, `/api/me`, `/api/students` payloads to include face registration fields.

---

### Component 3: Frontend API & Camera Interface

#### [MODIFY] [vocalid.js](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/js/vocalid.js)
- Add `uploadFaceSamples(imageBlobs)` for multi-sample upload.
- Add `verifyFace(imageBlob)` for live verification API call.

#### [NEW] [face.html](file:///c:/Users/user/OneDrive/Documents/vocalid/vocalid/face.html)
- Cyberpunk dark biometric interface matching VocalID design tokens.
- Interactive multi-sample webcam enrollment flow (3 samples: front, angle, front).
- Live face verification UI with visual confidence badge and match status.
- Responsive top navbar linking to Voice Enrollment (`voice.html`), Face Verification (`face.html`), and Dashboard (`dashboard.html`).

---

## 3. Verification Plan

### Automated / Command-line Verification
1. **Python ML Scripts**:
   - Run `python backend/ml/face_utils.py` to confirm models download successfully and OpenCV initializes properly.
   - Run `python backend/ml/face_enroll.py` with test sample image to verify JSON stdout.
2. **Backend Express Server**:
   - Run `npm start` in `backend/` and verify server startup and MongoDB connection.
   - Test `GET /api/health` endpoint.

### Manual UI Verification
1. Open `student-login.html`, log in as a student, navigate to `face.html`.
2. Test **Face Enrollment**: Allow camera access, capture 3 facial samples, submit profile, confirm `isFaceRegistered = true` saved in MongoDB.
3. Test **Face Verification**: Click "Verify My Face" in camera view, observe identity match output, similarity score, and confidence percentage.
4. Test failure modes: Cover camera or show no face to verify error messages ("No face detected").
5. Verify voice enrollment (`voice.html`) continues to work without regression.
