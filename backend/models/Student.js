const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  classId: { type: String, default: 'class1' },
  isVoiceRegistered: { type: Boolean, default: false },
  voiceRegisteredAt: { type: Date },
  voiceSamplePaths: [{ type: String }],
  isFaceRegistered: { type: Boolean, default: false },
  faceRegisteredAt: { type: Date },
  faceEmbeddings: { type: [[Number]], default: [] },
  faceSamplePaths: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Student || mongoose.model('Student', studentSchema);
