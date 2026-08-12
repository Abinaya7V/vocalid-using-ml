const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  classId: { type: String, default: 'class1' },
  voiceSamplePath: { type: String, default: null },
  voiceUploadedAt: { type: Date, default: null },
  isVoiceRegistered: { type: Boolean, default: false },
  voiceSamplePaths: [{ type: String }],
  isFaceRegistered: { type: Boolean, default: false },
  faceRegisteredAt: { type: Date },
  faceEmbeddings: { type: [[Number]], default: [] },
  faceSamplePaths: [{ type: String }],
  isRegistrationLocked: { type: Boolean, default: false },
  registrationLockedAt: { type: Date, default: null },
  biometricUpdateRequest: {
    status: { type: String, enum: ['none', 'pending', 'approved', 'denied'], default: 'none' },
    reason: { type: String, default: null },
    requestedAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    responseNote: { type: String, default: null }
  },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Hash password before saving if modified
studentSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare plain text password with hashed password
studentSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.models.Student || mongoose.model('Student', studentSchema);
