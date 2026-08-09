/**
 * VocalID Multimodal Biometric Fusion Engine
 * Calculates weighted decision score across Voice, Face, and LipSync/Liveness.
 */
function evaluateMultimodalFusion(params = {}) {
  const voiceScore = Math.max(0, Math.min(100, Math.round(params.voiceScore || 0)));
  const voiceMatched = Boolean(params.voiceMatched);

  const faceScore = Math.max(0, Math.min(100, Math.round(params.faceScore || 0)));
  const faceMatched = Boolean(params.faceMatched);

  const livenessScore = Math.max(0, Math.min(100, Math.round(params.livenessScore || 0)));
  const livenessPassed = Boolean(params.livenessPassed);
  const livenessMessage = params.livenessMessage || 'Liveness check failed.';

  // 1. Strict Hardened Anti-Spoofing & Liveness Check
  if (!livenessPassed) {
    return {
      verified: false,
      voiceScore,
      faceScore,
      livenessScore: 0,
      finalScore: 0,
      reason: `Liveness Failed: ${livenessMessage}`
    };
  }

  // 2. Voice Verification Check
  if (!voiceMatched || voiceScore < 70) {
    return {
      verified: false,
      voiceScore,
      faceScore,
      livenessScore,
      finalScore: Math.round(0.35 * voiceScore + 0.40 * faceScore + 0.25 * livenessScore),
      reason: `Voice Verification Failed: Speaker voice score (${voiceScore}%) did not meet required 70% confidence threshold.`
    };
  }

  // 3. Face Verification Check
  if (!faceMatched || faceScore < 60) {
    return {
      verified: false,
      voiceScore,
      faceScore,
      livenessScore,
      finalScore: Math.round(0.35 * voiceScore + 0.40 * faceScore + 0.25 * livenessScore),
      reason: `Face Verification Failed: Facial similarity score (${faceScore}%) did not match enrolled profile.`
    };
  }

  // 4. Multimodal Fusion Weighted Score Calculation:
  // Weight Distribution: Voice (35%), Face (40%), LipSync & Liveness (25%)
  const finalScore = Math.round(0.35 * voiceScore + 0.40 * faceScore + 0.25 * livenessScore);

  if (finalScore < 75) {
    return {
      verified: false,
      voiceScore,
      faceScore,
      livenessScore,
      finalScore,
      reason: `Multimodal Score Below Threshold: Combined score (${finalScore}%) is below minimum required 75%.`
    };
  }

  return {
    verified: true,
    voiceScore,
    faceScore,
    livenessScore,
    finalScore,
    reason: "All biometric checks (Voice, Face, LipSync/Liveness) passed successfully."
  };
}

module.exports = { evaluateMultimodalFusion };
